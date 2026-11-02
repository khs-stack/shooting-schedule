#!/usr/bin/env python3
"""메뉴잇 프로그램 연동 (상담 DB · CS 센터 · 파트너 배정)

build <dl> <since>      : 내려받은 문서로 Supabase에 보낼 SQL을 만든다 -> <dl>/sync.sql
apply <dl> <result>     : hub_sync 결과로 되돌려 쓸 문서와 계획을 만든다 -> <dl>/out/*, <dl>/plan_consult.json, <dl>/plan_cs.json

<dl> 폴더 구조 (ArtifactData list out_dir 그대로):
  <dl>/consult/leads/*.json  <dl>/consult/quotes/*.json  <dl>/consult/dispatch/*.json  <dl>/consult/links/*.json
  <dl>/cs/tickets/*.json     <dl>/cs/hub/*.json          <dl>/cs/stores/*.json
"""
import glob, json, os, re, sys


def docs(path):
    out = {}
    for f in glob.glob(os.path.join(path, "*.json")):
        try:
            d = json.load(open(f, encoding="utf-8"))
        except Exception:
            continue
        did = d.get("id") or os.path.basename(f)[:-5]
        out[did] = {"data": d.get("data", d), "version": d.get("version")}
    return out


def digits(s):
    return re.sub(r"\D", "", str(s or ""))


def latest_quote(quotes, lead_id):
    qs = [q["data"] for q in quotes.values() if q["data"].get("leadId") == lead_id]
    qs.sort(key=lambda q: q.get("updatedAt") or q.get("createdAt") or "")
    if not qs:
        return None
    q = qs[-1]
    m = q.get("menuit") or {}
    return {"title": q.get("title", ""), "status": q.get("status", ""), "tables": m.get("tables"), "devices": m.get("devices"), "billing": m.get("billing"),
            "color": m.get("color"), "mount": m.get("mount"), "extras": m.get("extras"), "pos": m.get("pos"), "posProduct": m.get("posProduct"),
            "kt": (q.get("kt") or {}).get("items") if (q.get("kt") or {}).get("on") else None}


def j(v):
    return ", ".join(str(x) for x in v) if isinstance(v, list) else str(v)


def env_text(l, q):
    parts = []
    if l.get("billingType"): parts.append(l["billingType"])
    if l.get("tabletCount"): parts.append(f"태블릿 {l['tabletCount']}대")
    elif q and q.get("tables"): parts.append(f"테이블 {q['tables']}대")
    if l.get("deviceType"): parts.append(j(l["deviceType"]))
    if l.get("posType") or l.get("posProduct"): parts.append(str(l.get("posProduct") or l.get("posType")))
    if l.get("mountType"): parts.append("거치 " + j(l["mountType"]))
    if l.get("deviceColor"): parts.append("색상 " + str(l["deviceColor"]))
    if q:
        ex = ", ".join(f"{ {'printer': '프린터'}.get(e.get('id'), e.get('id'))} {e.get('qty')}" for e in (q.get("extras") or []) if isinstance(e, dict))
        if ex: parts.append("추가 " + ex)
    s = " · ".join(parts)
    if l.get("installMemo"): s += ("\n" if s else "") + str(l["installMemo"])
    return s


def build(dl, since):
    leads, quotes = docs(f"{dl}/consult/leads"), docs(f"{dl}/consult/quotes")
    disp, tickets = docs(f"{dl}/consult/dispatch"), docs(f"{dl}/cs/tickets")
    since = since or ""
    L = []
    for lid, d in leads.items():
        l = d["data"]
        if since and (l.get("updatedAt") or "") < since and not any(x["data"].get("leadId") == lid and (x["data"].get("updatedAt") or "") >= since for x in quotes.values()):
            continue
        q = latest_quote(quotes, lid)
        L.append({"lead_id": lid, "kind": "인터넷" if l.get("intakeType") == "KT상담신청" else "메뉴잇", "sid": str(l.get("sid") or "").lstrip("Ss").strip(),
                  "store_name": l.get("storeName") or "", "owner": l.get("contactName") or "", "phone": l.get("phone") or "",
                  "phone_norm": l.get("phoneNormalized") or digits(l.get("phone")), "store_phone": l.get("storePhone") or "", "address": l.get("storeAddress") or "",
                  "biz_no": l.get("bizNo") or "", "source": l.get("acquisitionSource") or "", "sales_rep": l.get("salesRep") or "", "status": l.get("status") or "",
                  "stage": l.get("dealStage") or "", "deleted": bool(l.get("deleted")), "lead_updated_at": l.get("updatedAt") or "",
                  "contract": {k: l.get(k) for k in ["contractAt", "installDate", "installDoneAt", "openDate", "billingType", "posType", "posProduct", "tabletCount", "deviceType", "deviceColor", "mountType", "products", "subsidy", "ktSummary"] if l.get(k) not in (None, "", [])} | ({"quote": q} if q else {}),
                  "install_env": env_text(l, q), "notes": l.get("specialNotes") or ""})
    T = []
    for tid, d in tickets.items():
        t = d["data"]
        if since and (t.get("updatedAt") or "") < since:
            continue
        T.append({"id": tid, "sid": str(t.get("sid") or ""), "store_name": t.get("store") or "", "phone_norm": digits(t.get("phone")), "big": t.get("big") or "",
                  "small": t.get("small") or "", "title": t.get("title") or "", "status": t.get("status") or "", "urgent": bool(t.get("urgent")),
                  "posted_at": t.get("postedAt") or "", "done_at": t.get("doneAt") or ""})
    D = [{"key": k, "lead_id": d["data"].get("leadId"), "part": d["data"].get("part"), "requested_by": d["data"].get("requestedBy") or "", "note": d["data"].get("note") or ""}
         for k, d in disp.items() if d["data"].get("status", "요청") == "요청"]
    # 한 번에 보내는 양을 18KB 안쪽으로 나눈다. 마지막 파일 결과만 apply에 쓰면 된다.
    for f in glob.glob(f"{dl}/sync_*.sql"): os.remove(f)
    items = [("leads", x) for x in L] + [("tickets", x) for x in T]
    chunks, cur, size = [], {"leads": [], "tickets": [], "dispatch": []}, 0
    for kind, x in items:
        n = len(json.dumps(x, ensure_ascii=False))
        if size + n > 18000 and size:
            chunks.append(cur); cur, size = {"leads": [], "tickets": [], "dispatch": []}, 0
        cur[kind].append(x); size += n
    cur["dispatch"] = D; chunks.append(cur)
    sizes = []
    for i, c in enumerate(chunks, 1):
        payload = json.dumps(c, ensure_ascii=False, separators=(",", ":"))
        assert "$hub$" not in payload
        open(f"{dl}/sync_{i}.sql", "w", encoding="utf-8").write(f"select private.hub_sync($hub${payload}$hub$::jsonb) as r;")
        sizes.append(len(payload))
    print(json.dumps({"leads": len(L), "tickets": len(T), "dispatch": len(D), "files": [f"sync_{i}.sql" for i in range(1, len(chunks) + 1)], "bytes": sizes}, ensure_ascii=False))


def strip_meta(x):
    return {k: v for k, v in (x or {}).items() if k not in ("syncedAt",)}


def apply(dl, result_path):
    raw = open(result_path, encoding="utf-8").read()
    i = raw.find("{")
    res = json.loads(raw[i:raw.rfind("}") + 1])
    if "r" in res and isinstance(res["r"], dict):
        res = res["r"]
    out = f"{dl}/out"; os.makedirs(out, exist_ok=True)
    leads, links, disp = docs(f"{dl}/consult/leads"), docs(f"{dl}/consult/links"), docs(f"{dl}/consult/dispatch")
    hubd, stores, tickets = docs(f"{dl}/cs/hub"), docs(f"{dl}/cs/stores"), docs(f"{dl}/cs/tickets")
    pc, ps = [], []

    def add(plan, op, coll, did, data, cur):
        fn = f"{out}/{coll}__{did}.json"
        json.dump(data, open(fn, "w", encoding="utf-8"), ensure_ascii=False)
        e = {"op": op, "collection": coll, "doc_id": did, "file_path": os.path.abspath(fn)}
        if cur and cur.get("version"): e["if_version"] = cur["version"]
        plan.append(e)

    for lid, v in (res.get("links") or {}).items():
        cur = links.get(lid)
        if not cur or strip_meta(cur["data"]) != strip_meta(v):
            add(pc, "set", "links", lid, v, cur)
    for k in [x.get("key") for x in res.get("dispatchDone") or []]:
        cur = disp.get(k)
        if cur and cur["data"].get("status", "요청") == "요청":
            add(pc, "set", "dispatch", k, {**cur["data"], "status": "배정 접수"}, cur)
    # CS 센터 영업이관 건 중 상담 DB에 없는 매장은 신규 상담으로 넘긴다
    phones = {digits(d["data"].get("phone")) for d in leads.values()}
    for tid in res.get("unmatchedSales") or []:
        t = (tickets.get(tid) or {}).get("data")
        lid = "cs-" + tid
        if not t or lid in leads or (digits(t.get("phone")) and digits(t.get("phone")) in phones):
            continue
        now = t.get("postedAt") or ""
        add(pc, "set", "leads", lid, {"storeName": t.get("store") or t.get("title") or "CS 이관", "contactName": "", "phone": t.get("phone") or "", "phoneNormalized": digits(t.get("phone")),
            "storeAddress": "", "status": "신규 접수", "statusUpdatedAt": now, "intakeType": "신규문의", "acquisitionSource": "CS 이관", "salesRep": "석이",
            "specialNotes": f"[CS 센터 이관] {t.get('title') or ''}\n{t.get('body') or ''}".strip(), "sourceText": t.get("body") or "", "createdAt": now, "createdBy": "CS 센터 이관",
            "updatedAt": now, "updatedBy": "CS 센터 이관", "history": [{"at": now, "by": "CS 센터 이관", "kind": "created", "to": "신규문의"}], "threadNotes": [], "threadCount": 0,
            "recontact": False, "contactFirst": False, "deleted": False, "csTicketId": tid}, None)
    for tid, v in (res.get("hub") or {}).items():
        cur = hubd.get(tid)
        if not cur or strip_meta(cur["data"]) != strip_meta(v):
            add(ps, "set", "hub", tid, v, cur)
    for sid, v in (res.get("stores") or {}).items():
        cur = stores.get(sid)
        base = dict(cur["data"]) if cur else {}
        merged = dict(base)
        for k, val in v.items():
            if val and not base.get(k):
                merged[k] = val
        if merged != base:
            merged["src"] = base.get("src") or "상담 DB 연동"
            add(ps, "set", "stores", sid, merged, cur)
    for name, plan in (("consult", pc), ("cs", ps)):
        chunks = [plan[i:i + 50] for i in range(0, len(plan), 50)]
        json.dump(chunks, open(f"{dl}/plan_{name}.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps({"consult_writes": len(pc), "cs_writes": len(ps)}, ensure_ascii=False))


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "build":
        build(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "")
    elif cmd == "apply":
        apply(sys.argv[2], sys.argv[3])
