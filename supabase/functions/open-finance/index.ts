// Lembra Aí — conexão com bancos pelo Open Finance (via Pluggy)
// ações: token (abre o Pluggy Connect), sync (traz contas, gastos e investimentos), remover
import { createClient } from "jsr:@supabase/supabase-js@2";

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_SB, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const API = "https://api.pluggy.ai";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function cfg(n: string) {
  const env = Deno.env.get(n.toUpperCase());
  if (env) return env;
  const { data } = await admin.rpc("app_secret", { n });
  return (data as string) || "";
}
async function apiKey() {
  const clientId = await cfg("pluggy_client_id"), clientSecret = await cfg("pluggy_client_secret");
  if (!clientId || !clientSecret) return null;
  const r = await fetch(`${API}/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId, clientSecret }) });
  if (!r.ok) throw new Error("Pluggy recusou as chaves: " + (await r.text()).slice(0, 200));
  return (await r.json()).apiKey as string;
}
// deno-lint-ignore no-explicit-any
async function pg(key: string, path: string): Promise<any> {
  const r = await fetch(`${API}${path}`, { headers: { "X-API-KEY": key } });
  if (!r.ok) throw new Error(`Pluggy ${path.split("?")[0]}: ${r.status}`);
  return r.json();
}
const dia = (s?: string | null) => (s ? String(s).slice(0, 10) : null);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") || "";
    const { data: { user } } = await createClient(URL_SB, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } }).auth.getUser();
    if (!user) return json({ erro: "faça login de novo" }, 401);
    const body = await req.json().catch(() => ({}));
    const key = await apiKey();
    if (!key) return json({ erro: "nao_configurado" });

    if (body.acao === "token") {
      const r = await fetch(`${API}/connect_token`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-API-KEY": key },
        body: JSON.stringify({ clientUserId: user.id, ...(body.itemId ? { itemId: body.itemId } : {}) }),
      });
      if (!r.ok) return json({ erro: "token: " + (await r.text()).slice(0, 200) }, 500);
      return json({ accessToken: (await r.json()).accessToken, sandbox: (await cfg("pluggy_sandbox")) === "true" });
    }

    if (body.acao === "sync") {
      const itemId = String(body.itemId || "");
      const item = await pg(key, `/items/${encodeURIComponent(itemId)}`);
      if (item.clientUserId && item.clientUserId !== user.id) return json({ erro: "conexão não pertence a esta conta" }, 403);
      await admin.from("bank_items").upsert({ user_id: user.id, item_id: itemId, banco: item.connector?.name || "", status: item.status || "", atualizado_em: new Date().toISOString() });

      // gastos dos últimos 120 dias
      const de = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
      const contas = (await pg(key, `/accounts?itemId=${itemId}`)).results || [];
      let nTx = 0;
      for (const c of contas) {
        for (let page = 1; page <= 20; page++) {
          const r = await pg(key, `/transactions?accountId=${c.id}&from=${de}&pageSize=500&page=${page}`);
          // deno-lint-ignore no-explicit-any
          const rows = (r.results || []).map((t: any) => ({
            user_id: user.id, item_id: itemId, ext_id: t.id, conta: c.name || c.type || "",
            data: dia(t.date), descricao: t.description || "", valor: Number(t.amount) || 0,
            tipo: t.type || (Number(t.amount) < 0 ? "DEBIT" : "CREDIT"), categoria: t.category || "",
          // deno-lint-ignore no-explicit-any
          })).filter((x: any) => x.data);
          if (rows.length) { await admin.from("transacoes").upsert(rows); nTx += rows.length; }
          if (!r.totalPages || page >= r.totalPages) break;
        }
      }
      // investimentos
      const inv = (await pg(key, `/investments?itemId=${itemId}&pageSize=500`)).results || [];
      // deno-lint-ignore no-explicit-any
      const invRows = inv.map((i: any) => ({
        user_id: user.id, item_id: itemId, ext_id: i.id, nome: i.name || i.code || "Investimento",
        tipo: i.type || "", subtipo: i.subtype || "", instituicao: i.issuer || item.connector?.name || "",
        saldo: Number(i.balance ?? i.amount) || 0, valor_aplicado: i.amountOriginal != null ? Number(i.amountOriginal) : null,
        vencimento: dia(i.dueDate), rent_mes: i.lastMonthRate ?? null, rent_12m: i.lastTwelveMonthsRate ?? null,
        atualizado_em: new Date().toISOString(),
      }));
      await admin.from("investimentos").delete().eq("user_id", user.id).eq("item_id", itemId);
      if (invRows.length) await admin.from("investimentos").insert(invRows);
      return json({ banco: item.connector?.name || "", contas: contas.length, transacoes: nTx, investimentos: invRows.length });
    }

    if (body.acao === "remover") {
      const itemId = String(body.itemId || "");
      const { data: meu } = await admin.from("bank_items").select("item_id").eq("user_id", user.id).eq("item_id", itemId).maybeSingle();
      if (!meu) return json({ erro: "conexão não encontrada" }, 404);
      await fetch(`${API}/items/${encodeURIComponent(itemId)}`, { method: "DELETE", headers: { "X-API-KEY": key } });
      for (const t of ["transacoes", "investimentos", "bank_items"]) await admin.from(t).delete().eq("user_id", user.id).eq("item_id", itemId);
      return json({ ok: true });
    }
    return json({ erro: "ação desconhecida" }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message || e) }, 500);
  }
});
