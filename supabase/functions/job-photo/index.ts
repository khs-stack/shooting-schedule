// 시공 완료 사진 업로드·삭제 (건당 20장)
import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const MAX = 20, BUCKET = "job-photos";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, apikey, authorization", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const out = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function partnerOf(token: string) {
  if (!token) return null;
  const { data } = await sb.from("sessions").select("partner_id,expires_at").eq("token", token).maybeSingle();
  return data && new Date(data.expires_at) > new Date() ? data.partner_id as string : null;
}
async function locked(pid: string, month: string | null) {
  if (!month) return false;
  const { data } = await sb.from("settlements").select("status").eq("partner_id", pid).eq("month", month).maybeSingle();
  return !!data && ["확인요청", "파트너확인", "기안완료", "지급완료"].includes(String(data.status));
}
async function sync(jobId: string) {
  const { count } = await sb.from("job_photos").select("id", { count: "exact", head: true }).eq("job_id", jobId);
  await sb.from("jobs").update({ photo_count: count || 0 }).eq("id", jobId);
  return count || 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return out({ ok: false, error: "method" }, 405);
  const p = await req.json().catch(() => ({}));
  const pid = await partnerOf(String(p.token || ""));
  if (!pid) return out({ ok: false, error: "auth" });
  const { data: job } = await sb.from("jobs").select("id,partner_id,status,settle_month").eq("id", p.job_id).maybeSingle();
  if (!job || job.partner_id !== pid || job.status === "취소") return out({ ok: false, error: "not_found" });
  if (await locked(pid, job.settle_month)) return out({ ok: false, error: "locked" });

  if (p.action === "upload") {
    const m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(String(p.data || ""));
    if (!m) return out({ ok: false, error: "bad_image" });
    const bytes = Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0));
    if (bytes.length > 3 * 1024 * 1024) return out({ ok: false, error: "too_big" });
    const { count } = await sb.from("job_photos").select("id", { count: "exact", head: true }).eq("job_id", job.id);
    if ((count || 0) >= MAX) return out({ ok: false, error: "limit", max: MAX });
    const ext = m[2] === "jpeg" ? "jpg" : m[2], path = `${job.id}/${crypto.randomUUID()}.${ext}`;
    const up = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: m[1], upsert: false });
    if (up.error) return out({ ok: false, error: "upload" });
    const url = `${SB_URL}/storage/v1/object/public/${BUCKET}/${path}`;
    const { data: row } = await sb.from("job_photos").insert({ job_id: job.id, partner_id: pid, path, url, bytes: bytes.length }).select("id,url").single();
    return out({ ok: true, photo: row, count: await sync(job.id) });
  }
  if (p.action === "delete") {
    const { data: ph } = await sb.from("job_photos").select("id,path").eq("id", p.photo_id).eq("job_id", job.id).maybeSingle();
    if (!ph) return out({ ok: false, error: "not_found" });
    await sb.storage.from(BUCKET).remove([ph.path]);
    await sb.from("job_photos").delete().eq("id", ph.id);
    return out({ ok: true, count: await sync(job.id) });
  }
  return out({ ok: false, error: "bad_action" });
});
