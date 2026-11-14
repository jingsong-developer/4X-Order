import { getStore } from "@netlify/blobs";

export const config = { path: "/api/*" };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

async function sha(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

const str = (v, max) => String(v ?? "").slice(0, max).trim();

function cleanItems(items) {
  if (!Array.isArray(items)) return null;
  if (items.length > 30) return null;
  return items
    .map((l) => ({
      n: str(l.n, 80),
      qty: Math.max(1, Math.min(20, parseInt(l.qty, 10) || 1)),
      opt: str(l.opt, 30),
      side: str(l.side, 40),
      drink: str(l.drink, 60),
      note: str(l.note, 80),
    }))
    .filter((l) => l.n);
}

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const store = getStore({ name: "4x-lunch", consistency: "strong" });

  const cfg = (await store.get("config", { type: "json" })) || { cutoff: "", locked: false, pinHash: "" };
  const publicCfg = { cutoff: cfg.cutoff || "", locked: !!cfg.locked };
  const closed = () => !!cfg.locked || (!!cfg.cutoff && Date.now() > Date.parse(cfg.cutoff));

  if (req.method === "GET" && route === "state") {
    const { blobs } = await store.list({ prefix: "o/" });
    const orders = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }))))
      .filter(Boolean)
      .map(({ tokenHash, ...o }) => o);
    return json({ orders, config: publicCfg, hasPin: !!cfg.pinHash });
  }

  let body = {};
  try {
    body = await req.json();
  } catch {}

  const isOrg = !!cfg.pinHash && !!body.orgPin && (await sha("org:" + body.orgPin)) === cfg.pinHash;

  if (route === "organiser" && req.method === "POST") {
    const pin = String(body.pin || "");
    if (!/^\d{4,12}$/.test(pin)) return json({ error: "PIN must be 4 to 12 digits" }, 400);
    if (body.setup) {
      if (cfg.pinHash) return json({ error: "PIN already set" }, 409);
      await store.setJSON("config", { ...cfg, pinHash: await sha("org:" + pin) });
      return json({ ok: true });
    }
    if (!cfg.pinHash) return json({ error: "No PIN set yet" }, 409);
    if ((await sha("org:" + pin)) !== cfg.pinHash) return json({ error: "Wrong PIN" }, 403);
    return json({ ok: true });
  }

  if (route === "config" && req.method === "POST") {
    if (!isOrg) return json({ error: "Wrong PIN" }, 403);
    const next = { ...cfg };
    if (body.cutoff !== undefined) {
      const c = str(body.cutoff, 40);
      if (c && isNaN(Date.parse(c))) return json({ error: "Bad date" }, 400);
      next.cutoff = c;
    }
    if (body.locked !== undefined) next.locked = !!body.locked;
    await store.setJSON("config", next);
    return json({ ok: true, config: { cutoff: next.cutoff || "", locked: !!next.locked } });
  }

  if (route === "order" && (req.method === "PUT" || req.method === "DELETE")) {
    const id = String(body.id || "");
    if (!/^[a-z0-9]{8,40}$/i.test(id)) return json({ error: "Bad id" }, 400);
    const key = "o/" + id;
    const prev = await store.get(key, { type: "json" });
    const tokenHash = body.token ? await sha("tok:" + body.token) : "";
    const owns = !!prev && !!tokenHash && prev.tokenHash === tokenHash;
    if (prev && !owns && !isOrg) return json({ error: "Not your order" }, 403);
    if (!prev && !tokenHash && !isOrg) return json({ error: "Missing token" }, 400);
    if (closed() && !isOrg) return json({ error: "Orders are closed" }, 423);

    if (req.method === "DELETE") {
      await store.delete(key);
      return json({ ok: true });
    }
    const items = cleanItems(body.items);
    if (!items) return json({ error: "Bad items" }, 400);
    const { blobs } = await store.list({ prefix: "o/" });
    if (!prev && blobs.length >= 200) return json({ error: "Too many orders" }, 429);
    await store.setJSON(key, {
      id,
      name: str(body.name, 40),
      items,
      updatedAt: new Date().toISOString(),
      tokenHash: prev ? prev.tokenHash : tokenHash,
    });
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
};
