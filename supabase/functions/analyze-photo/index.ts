import { createClient } from "npm:@supabase/supabase-js@2";

// Claude photo analysis for the Biosecurity & Hygiene audit app.
// The Anthropic key lives ONLY here, as the Supabase secret ANTHROPIC_API_KEY. It is never sent to the browser.
// Optional secrets: AI_MODEL (default claude-sonnet-5-5), AI_DAILY_LIMIT (per user per day, default 60).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const MAX_IMAGES = 4;
const MAX_B64 = 2_000_000; // ~1.5 MB per picture (the app sends ~300 KB)

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "bad", message: "Method not allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Signed-in, active editor or admin only (viewers cannot spend the AI budget)
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer /i, "");
  const { data: ud, error: ue } = await admin.auth.getUser(token);
  if (ue || !ud?.user) return json({ ok: false, error: "login" }, 401);
  const { data: me } = await admin.from("profiles").select("id,username,email,role,status").eq("id", ud.user.id).maybeSingle();
  if (!me || me.status !== "active" || !["admin", "editor"].includes(me.role)) return json({ ok: false, error: "forbidden" }, 403);

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ ok: false, error: "nokey" }, 200);
  const model = Deno.env.get("AI_MODEL") || "claude-sonnet-5-5";
  const limit = Math.max(1, parseInt(Deno.env.get("AI_DAILY_LIMIT") || "60", 10) || 60);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad", message: "Invalid request." }, 400); }

  // 2. Daily cap per user (counted from the activity history, so it also shows who used it)
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const { count } = await admin.from("audit_log").select("id", { count: "exact", head: true })
    .eq("user_id", me.id).eq("action", "photo_analyzed").gte("at", since.toISOString());
  const used = count ?? 0;

  const call = async (content: unknown[], max_tokens: number) => {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens, messages: [{ role: "user", content }] }),
    });
    const j = await r.json().catch(() => ({}));
    return { r, j };
  };
  const fail = (r: Response, j: any) => {
    const m = String(j?.error?.message || "");
    if (r.status === 429 || r.status === 529) return json({ ok: false, error: "rate_limited", message: m });
    if (r.status === 401 || r.status === 403) return json({ ok: false, error: "api", message: "The Anthropic key was rejected. Check ANTHROPIC_API_KEY." });
    if (r.status === 400 && /image/i.test(m)) return json({ ok: false, error: "image_rejected", message: m });
    return json({ ok: false, error: "api", message: m.slice(0, 200) || "Status " + r.status });
  };

  // 3. Connection test (used by the "Test Claude connection" button)
  if (body?.ping) {
    const { r, j } = await call([{ type: "text", text: "Reply with the single word: ok" }], 8);
    if (!r.ok) return fail(r, j);
    return json({ ok: true, live: true, model, left: Math.max(0, limit - used) });
  }

  // 4. Analyse photos
  const prompt = String(body?.prompt || "");
  const images: string[] = Array.isArray(body?.images) ? body.images.slice(0, MAX_IMAGES).map(String) : [];
  if (!prompt || prompt.length > 8000 || !images.length) return json({ ok: false, error: "bad", message: "A prompt and at least one picture are required." }, 400);
  if (images.some((b) => b.length > MAX_B64)) return json({ ok: false, error: "image_rejected", message: "Picture too large." });
  if (used >= limit) return json({ ok: false, error: "cap" });

  const content: unknown[] = images.map((b) => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: b.replace(/^data:image\/\w+;base64,/, "") },
  }));
  content.push({ type: "text", text: prompt });
  const { r, j } = await call(content, 600);
  if (!r.ok) return fail(r, j);

  const text = (j?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  let result: unknown = null;
  try { result = m ? JSON.parse(m[0]) : null; } catch { /* handled below */ }
  if (!result) return json({ ok: false, error: "invalid_json" });

  await admin.from("audit_log").insert({
    user_id: me.id, username: me.username, email: me.email, action: "photo_analyzed", entity: "bio_photos", entity_id: null,
    details: { images: images.length, model },
  });
  return json({ ok: true, result, left: Math.max(0, limit - used - 1) });
});
