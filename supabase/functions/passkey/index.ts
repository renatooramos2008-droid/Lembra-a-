// Lembra Aí — entrar com Face ID / digital (WebAuthn / passkeys)
// O celular confere o rosto ou a digital; o servidor confere a assinatura e libera a sessão.
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "npm:@simplewebauthn/server@13";

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_SB, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const b64u = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function site() {
  const { data } = await admin.rpc("app_secret", { n: "app_url" });
  const u = new URL((data as string) || "https://localhost/");
  return { origin: u.origin, rpID: u.hostname };
}
async function usuario(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  const { data: { user } } = await createClient(URL_SB, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } }).auth.getUser();
  return user;
}
async function desafio(id: string, tipo: string) {
  const { data } = await admin.from("webauthn_desafios").delete().eq("id", id).eq("tipo", tipo).select().maybeSingle();
  if (!data || Date.now() - Date.parse(data.criado_em) > 5 * 60000) return null;
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const { origin, rpID } = await site();
    await admin.from("webauthn_desafios").delete().lt("criado_em", new Date(Date.now() - 10 * 60000).toISOString());

    // ---- cadastrar o Face ID deste aparelho (precisa estar logado com senha) ----
    if (body.acao === "cadastro-opcoes") {
      const user = await usuario(req);
      if (!user) return json({ erro: "Entre com sua senha primeiro." }, 401);
      const { data: atuais } = await admin.from("passkeys").select("id,transports").eq("user_id", user.id);
      const options = await generateRegistrationOptions({
        rpName: "Lembra Aí", rpID, userName: user.email || user.id, userDisplayName: user.user_metadata?.nome || user.email || "",
        userID: new TextEncoder().encode(user.id), attestationType: "none",
        excludeCredentials: (atuais || []).map((c) => ({ id: c.id, transports: c.transports })),
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
      });
      const { data: d } = await admin.from("webauthn_desafios").insert({ user_id: user.id, challenge: options.challenge, tipo: "cadastro" }).select("id").single();
      return json({ options, did: d!.id });
    }
    if (body.acao === "cadastro-verificar") {
      const user = await usuario(req);
      if (!user) return json({ erro: "Entre com sua senha primeiro." }, 401);
      const d = await desafio(String(body.did || ""), "cadastro");
      if (!d || d.user_id !== user.id) return json({ erro: "Tempo esgotado. Tente de novo." }, 400);
      const v = await verifyRegistrationResponse({ response: body.resposta, expectedChallenge: d.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
      if (!v.verified || !v.registrationInfo) return json({ erro: "Não foi possível confirmar o Face ID." }, 400);
      const c = v.registrationInfo.credential;
      await admin.from("passkeys").upsert({ id: c.id, user_id: user.id, public_key: b64u(c.publicKey), counter: c.counter, transports: c.transports || [], aparelho: String(body.aparelho || "").slice(0, 80) });
      return json({ ok: true, id: c.id });
    }

    // ---- entrar com Face ID ----
    if (body.acao === "entrada-opcoes") {
      let creds: { id: string; transports: string[] }[] = [];
      if (body.email) {
        const { data: p } = await admin.from("profiles").select("id").eq("email", String(body.email).toLowerCase()).maybeSingle();
        if (p) creds = (await admin.from("passkeys").select("id,transports").eq("user_id", p.id)).data || [];
        if (!creds.length) return json({ erro: "Face ID não está ativado para esta conta. Entre com a senha." }, 404);
      }
      const options = await generateAuthenticationOptions({ rpID, userVerification: "required", allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })) });
      const { data: d } = await admin.from("webauthn_desafios").insert({ challenge: options.challenge, tipo: "entrada" }).select("id").single();
      return json({ options, did: d!.id });
    }
    if (body.acao === "entrada-verificar") {
      const d = await desafio(String(body.did || ""), "entrada");
      if (!d) return json({ erro: "Tempo esgotado. Tente de novo." }, 400);
      const { data: pk } = await admin.from("passkeys").select("*").eq("id", String(body.resposta?.id || "")).maybeSingle();
      if (!pk) return json({ erro: "Este Face ID não está mais cadastrado. Entre com a senha." }, 404);
      const v = await verifyAuthenticationResponse({
        response: body.resposta, expectedChallenge: d.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: pk.id, publicKey: fromB64u(pk.public_key), counter: Number(pk.counter), transports: pk.transports },
      });
      if (!v.verified) return json({ erro: "Face ID não confirmado." }, 401);
      await admin.from("passkeys").update({ counter: v.authenticationInfo.newCounter, usado_em: new Date().toISOString() }).eq("id", pk.id);
      const { data: u } = await admin.auth.admin.getUserById(pk.user_id);
      const email = u?.user?.email;
      if (!email) return json({ erro: "Conta não encontrada." }, 404);
      const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
      if (error || !link?.properties?.hashed_token) return json({ erro: "Não foi possível abrir a sessão." }, 500);
      return json({ token_hash: link.properties.hashed_token, email });
    }

    // ---- desativar o Face ID deste aparelho ----
    if (body.acao === "remover") {
      const user = await usuario(req);
      if (!user) return json({ erro: "Entre de novo." }, 401);
      await admin.from("passkeys").delete().eq("user_id", user.id).eq("id", String(body.id || ""));
      return json({ ok: true });
    }
    return json({ erro: "ação desconhecida" }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message || e) }, 500);
  }
});
