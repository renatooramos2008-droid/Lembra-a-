// Lembra Aí — excluir a conta e todos os dados (direito do titular, LGPD)
import { createClient } from "jsr:@supabase/supabase-js@2";

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_SB, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const segredo = async (n: string) => Deno.env.get(n.toUpperCase()) || ((await admin.rpc("app_secret", { n })).data as string) || "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") || "";
    const { data: { user } } = await createClient(URL_SB, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } }).auth.getUser();
    if (!user) return json({ erro: "Entre na sua conta de novo." }, 401);
    const body = await req.json().catch(() => ({}));
    if (body.acao !== "excluir" || body.confirmacao !== "EXCLUIR") return json({ erro: "Confirmação inválida." }, 400);

    // 1) desconecta os bancos na Pluggy (encerra o consentimento do Open Finance)
    const { data: itens } = await admin.from("bank_items").select("item_id").eq("user_id", user.id);
    if (itens?.length) {
      const id = await segredo("pluggy_client_id"), sec = await segredo("pluggy_client_secret");
      if (id && sec) {
        const r = await fetch("https://api.pluggy.ai/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: id, clientSecret: sec }) });
        if (r.ok) {
          const { apiKey } = await r.json();
          for (const it of itens) await fetch(`https://api.pluggy.ai/items/${encodeURIComponent(it.item_id)}`, { method: "DELETE", headers: { "X-API-KEY": apiKey } });
        }
      }
    }
    // 2) apaga o usuário: perfil, contas, agenda, notificações, Face ID, bancos e gastos saem juntos (cascata)
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) return json({ erro: "Não foi possível excluir: " + error.message }, 500);
    return json({ ok: true });
  } catch (e) {
    return json({ erro: String((e as Error).message || e) }, 500);
  }
});
