// 파트너 집 → 매장 편도 거리 계산. 네이버 키(NCP_KEY_ID/NCP_KEY)가 있으면 네이버 길찾기, 없으면 OSM 근사치.
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const NCP_ID = Deno.env.get("NCP_KEY_ID") || "", NCP_KEY = Deno.env.get("NCP_KEY") || "";
const UA = "menuit-partner/1.0 (khs@menuit.io)";
type Pt = { lat: number; lng: number; src: string };

const HOOK = Deno.env.get("HOOK_KEY") || "";

const clean = (a: string) => a.replace(/\([^)]*\)/g, " ").replace(/\b\d+\s*층\b|\b\d+\s*호\b|지하\s*\d*\s*층?|[,·]/g, " ").replace(/\s+/g, " ").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function naverGeo(q: string): Promise<Pt | null> {
  const r = await fetch("https://maps.apigw.ntruss.com/map-geocode/v2/geocode?query=" + encodeURIComponent(q), { headers: { "x-ncp-apigw-api-key-id": NCP_ID, "x-ncp-apigw-api-key": NCP_KEY } });
  if (!r.ok) return null;
  const j = await r.json(); const a = j.addresses?.[0];
  return a ? { lat: Number(a.y), lng: Number(a.x), src: "naver" } : null;
}
async function osmGeo(q: string): Promise<Pt | null> {
  const toks = clean(q).split(" ");
  for (let n = toks.length; n >= 1; n--) {
    const s = toks.slice(0, n).join(" ");
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=kr&accept-language=ko&q=${encodeURIComponent(s)}`, { headers: { "User-Agent": UA } });
    await sleep(1100);
    if (!r.ok) continue;
    const j = await r.json();
    if (j[0]) return { lat: Number(j[0].lat), lng: Number(j[0].lon), src: n === toks.length ? "osm" : "osm-approx" };
  }
  return null;
}
async function geocode(addr: string): Promise<Pt | null> {
  const key = clean(addr);
  if (!key || /확인\s*필요/.test(key)) return null;
  const { data: c } = await sb.from("geo_cache").select("lat,lng,src").eq("addr", key).maybeSingle();
  if (c && (c.src === "naver" || !NCP_ID)) return c as Pt;
  let p: Pt | null = null;
  if (NCP_ID) p = await naverGeo(addr).catch(() => null) || await naverGeo(key).catch(() => null);
  if (!p) p = await osmGeo(addr).catch(() => null);
  if (p) await sb.from("geo_cache").upsert({ addr: key, lat: p.lat, lng: p.lng, src: p.src, at: new Date().toISOString() });
  return p;
}
async function route(a: Pt, b: Pt): Promise<{ km: number; toll: number | null; src: string } | null> {
  if (NCP_ID) {
    const r = await fetch(`https://maps.apigw.ntruss.com/map-direction/v1/driving?start=${a.lng},${a.lat}&goal=${b.lng},${b.lat}&option=trafast`, { headers: { "x-ncp-apigw-api-key-id": NCP_ID, "x-ncp-apigw-api-key": NCP_KEY } });
    if (r.ok) { const j = await r.json(); const s = j.route?.trafast?.[0]?.summary; if (s) return { km: Math.round(s.distance / 100) / 10, toll: s.tollFare ?? null, src: "naver" }; }
  }
  const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`, { headers: { "User-Agent": UA } });
  if (r.ok) { const j = await r.json(); const d = j.routes?.[0]?.distance; if (d) return { km: Math.round(d / 100) / 10, toll: null, src: "osm" }; }
  return null;
}

async function calcJob(job: { id: string; store_address: string; partner_id: string }, home: string) {
  const at = new Date().toISOString();
  if (!home?.trim()) return sb.from("jobs").update({ route_err: "no_home", route_at: at }).eq("id", job.id);
  const [a, b] = [await geocode(home), await geocode(job.store_address || "")];
  if (!a || !b) return sb.from("jobs").update({ route_err: !a ? "home_addr" : "store_addr", route_at: at }).eq("id", job.id);
  const r = await route(a, b);
  if (!r) return sb.from("jobs").update({ route_err: "route", route_at: at }).eq("id", job.id);
  const src = r.src === "naver" ? "naver" : a.src === "osm-approx" || b.src === "osm-approx" ? "approx" : "osm";
  return sb.from("jobs").update({ route_km: r.km, route_toll: r.toll, route_src: src, route_err: null, route_at: at }).eq("id", job.id);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("no", { status: 405 });
  if (!HOOK || req.headers.get("x-hook") !== HOOK) return new Response("forbidden", { status: 401 });
  const p = await req.json().catch(() => ({}));
  let q = sb.from("jobs").select("id,store_address,partner_id,status,settle_month,signed_at").neq("status", "취소").not("partner_id", "is", null);
  if (p.job_id) q = q.eq("id", p.job_id);
  else if (p.partner_id) q = q.eq("partner_id", p.partner_id).is("settle_month", null);
  else if (p.all) q = q.is("route_km", null).is("settle_month", null).limit(40);
  else return new Response("bad", { status: 400 });
  const { data: jobs } = await q;
  const ids = [...new Set((jobs || []).map((j) => j.partner_id))];
  const { data: ps } = ids.length ? await sb.from("partners").select("id,home_address").in("id", ids) : { data: [] };
  const home = Object.fromEntries((ps || []).map((x) => [x.id, x.home_address]));
  let n = 0;
  for (const j of jobs || []) { await calcJob(j, home[j.partner_id] || ""); n++; }
  return Response.json({ ok: true, n });
});
