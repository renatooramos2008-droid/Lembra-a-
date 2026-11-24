// Lembra Aí — assinatura mensal pelo Mercado Pago (14 dias grátis, depois R$ 14,90/mês)
// Ações do app (com login): status · assinar · cancelar
// Aviso do Mercado Pago (?aviso=1): nunca confia no corpo; consulta a assinatura direto no Mercado Pago.
import { createClient } from "jsr:@supabase/supabase-js@2";

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_SB, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const segredo = async (n: string) => Deno.env.get(n.toUpperCase()) || ((await admin.rpc("app_secret", { n })).data as string) || "";
const MP = "https://api.mercadopago.com";
const mapa: Record<string, string> = { pending: "pendente", authorized: "ativa", paused: "pausada", cancelled: "cancelada" };

async function mp(path: string, init: RequestInit = {}) {
  const tk = await segredo("mp_access_token");
  if (!tk) throw new Error("Pagamento ainda não configurado. Tente mais tarde.");
  const r = await fetch(MP + path, { ...init, headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json", ...(init.headers || {}) } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.message || "Mercado Pago respondeu " + r.status);
  return b;
}
// deno-lint-ignore no-explicit-any
async function sincronizar(pre: any) {
  const uid = pre.external_reference, st = mapa[pre.status];
  if (!uid || !st) return null;
  const { data: atual } = await admin.from("assinaturas").select("mp_id,status").eq("user_id", uid).maybeSingle();
  // só aceita a assinatura registrada para esta pessoa (ou a primeira)
  if (atual?.mp_id && atual.mp_id !== pre.id && st !== "ativa") return atual.status;
  await admin.from("assinaturas").upsert({ user_id: uid, mp_id: pre.id, status: st, atualizado_em: new Date().toISOString() });
  return st;
}
const resumo = (a: { status: string; teste_fim: string; valor: number }) => {
  const dias = Math.ceil((Date.parse(a.teste_fim) - Date.now()) / 864e5);
  return { status: a.status, teste_fim: a.teste_fim, dias_teste: Math.max(0, dias), valor: +a.valor, acesso: a.status === "ativa" || dias > 0 };
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const u = new URL(req.url);
  try {
    if (u.searchParams.get("aviso")) {
      const b = await req.json().catch(() => ({}));
      const id = b?.data?.id || u.searchParams.get("data.id") || u.searchParams.get("id");
      const tipo = b?.type || u.searchParams.get("type") || u.searchParams.get("topic") || "";
      if (id && /preapproval/.test(tipo)) await sincronizar(await mp("/preapproval/" + encodeURIComponent(id)));
      return json({ ok: true });
    }
    const auth = req.headers.get("Authorization") || "";
    const { data: { user } } = await createClient(URL_SB, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } }).auth.getUser();
    if (!user) return json({ erro: "Entre na sua conta de novo." }, 401);
    const body = await req.json().catch(() => ({}));
    let { data: a } = await admin.from("assinaturas").select("*").eq("user_id", user.id).maybeSingle();
    if (!a) { await admin.from("assinaturas").insert({ user_id: user.id }); a = (await admin.from("assinaturas").select("*").eq("user_id", user.id).single()).data; }

    if (body.acao === "status") {
      if (a.mp_id && a.status !== "ativa") { try { await sincronizar(await mp("/preapproval/" + a.mp_id)); a = (await admin.from("assinaturas").select("*").eq("user_id", user.id).single()).data; } catch (_) { /* segue com o que tem */ } }
      return json(resumo(a));
    }
    if (body.acao === "assinar") {
      if (a.status === "ativa") return json({ ...resumo(a), ja: true });
      const app = (await segredo("app_url")) || "https://renatooramos2008-droid.github.io/Lembra-a-/";
      const inicio = new Date(Math.max(Date.now(), Date.parse(a.teste_fim)) + 60000).toISOString();
      const pre = await mp("/preapproval", { method: "POST", body: JSON.stringify({
        reason: "Lembra Aí · plano mensal",
        external_reference: user.id,
        payer_email: user.email,
        back_url: app + "#plano-ok",
        status: "pending",
        auto_recurring: { frequency: 1, frequency_type: "months", start_date: inicio, transaction_amount: +a.valor, currency_id: "BRL" },
      }) });
      await admin.from("assinaturas").update({ mp_id: pre.id, status: a.status === "teste" ? "teste" : "pendente", atualizado_em: new Date().toISOString() }).eq("user_id", user.id);
      return json({ link: pre.init_point });
    }
    if (body.acao === "cancelar") {
      if (a.mp_id) await mp("/preapproval/" + a.mp_id, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) });
      await admin.from("assinaturas").update({ status: "cancelada", atualizado_em: new Date().toISOString() }).eq("user_id", user.id);
      return json(resumo({ ...a, status: "cancelada" }));
    }
    return json({ erro: "Ação inválida." }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message || e) }, 500);
  }
});
