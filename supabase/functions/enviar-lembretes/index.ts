// Lembra Aí — envio automático de lembretes (roda a cada minuto pelo agendador)
// Canais: notificação no celular (push), e-mail (Resend) e WhatsApp (API oficial da Meta).
// Assinaturas: só notificação do app.
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const OFF = "-03:00"; // horário de Brasília
const TZH = -3;
const JANELA_MIN = 10; // alerta atrasado até 10 min ainda é enviado

const secret = async (n: string): Promise<string | null> => {
  const { data } = await sb.rpc("app_secret", { n });
  return (data as string) || null;
};
const pad = (n: number) => String(n).padStart(2, "0");
const hojeBR = () => {
  const l = new Date(Date.now() + TZH * 3600e3);
  return `${l.getUTCFullYear()}-${pad(l.getUTCMonth() + 1)}-${pad(l.getUTCDate())}`;
};
const addDays = (s: string, n: number) => {
  const d = new Date(s + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dd = (a: string, b: string) => Math.round((Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 864e5);
const at = (day: string, hm: string) => Date.parse(`${day}T${hm}:00${OFF}`);
const fmtD = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
const brl = (v: number) => v ? v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "";
const quando = (day: string) => {
  const n = dd(day, hojeBR());
  return n === 0 ? "hoje" : n === 1 ? "amanhã" : `em ${n} dias (${fmtD(day)})`;
};

// mesma regra de repetição do app
// deno-lint-ignore no-explicit-any
function occurs(e: any, day: string) {
  const b = String(e.ini || "").slice(0, 10), n = dd(day, b);
  if (!b || n < 0 || (e.ex || []).includes(day) || (e.repAte && day > e.repAte)) return false;
  const span = dd(String(e.fim || e.ini).slice(0, 10), b);
  switch (e.rep) {
    case "Diariamente": return true;
    case "Dias úteis": { const w = new Date(day + "T12:00:00Z").getUTCDay(); return w > 0 && w < 6; }
    case "Semanalmente": return n % 7 === 0;
    case "A cada 2 semanas": return n % 14 === 0;
    case "Mensalmente": return day.slice(8) === b.slice(8);
    case "Anualmente": return day.slice(5) === b.slice(5);
    default: return n <= Math.max(0, span);
  }
}

type Alerta = { chave: string; titulo: string; corpo: string; url: string; soApp: boolean; conta?: string };

// deno-lint-ignore no-explicit-any
function alertasDe(data: any, de: number, ate: number): Alerta[] {
  const out: Alerta[] = [], hoje = hojeBR();
  for (let i = -1; i <= 8; i++) {
    const day = addDays(hoje, i);
    // deno-lint-ignore no-explicit-any
    for (const e of (data.evs || []) as any[]) {
      if (!occurs(e, day)) continue;
      for (const m of (e.alerts || []) as number[]) {
        const t = at(day, e.allDay ? "09:00" : String(e.ini).slice(11, 16)) - m * 60000;
        if (t > de && t <= ate) {
          const hora = e.allDay ? "" : ` às ${String(e.ini).slice(11, 16)}`;
          out.push({
            chave: `e|${e.id}|${day}|${m}`,
            titulo: `📅 ${e.titulo}`,
            corpo: `${quando(day).replace(/^./, (c) => c.toUpperCase())}${hora}${e.local ? " · " + e.local : ""}`,
            url: `#det-e-${e.id}-${day}`,
            soApp: false,
          });
        }
      }
    }
  }
  // deno-lint-ignore no-explicit-any
  for (const x of (data.contas || []) as any[]) {
    if (x.status === "Pago" || !x.venc) continue;
    const dias = Number.isFinite(+x.dias) ? +x.dias : 3;
    for (const n of [...new Set([dias, 0])]) {
      const t = at(addDays(x.venc, -n), "09:00");
      if (!(t > de && t <= ate)) continue;
      const assin = x.cat === "Assinatura", v = brl(+x.valor);
      out.push({
        chave: `c|${x.id}|${x.venc}|${n}`,
        titulo: assin ? `💳 ${x.nome} renova ${quando(x.venc)}` : `💰 ${x.nome} vence ${quando(x.venc)}`,
        corpo: assin ? `${v ? v + " · " : ""}Você ainda usa? Toque para ver.` : `${v ? v + " · " : ""}${x.pix ? "Toque para copiar o código e pagar." : "Toque para ver como pagar."}`,
        url: assin ? `#det-c-${x.id}` : `#pagar-c-${x.id}`,
        soApp: assin, conta: assin ? undefined : x.id,
      });
    }
  }
  return out;
}

async function marcar(user_id: string, chave: string, canal: string) {
  const { data, error } = await sb.from("envios").insert({ user_id, chave, canal }).select("chave");
  return !error && !!data?.length; // false = já enviado antes
}
async function status(user_id: string, chave: string, canal: string, st: string, detalhe = "") {
  await sb.from("envios").update({ status: st, detalhe: detalhe.slice(0, 500) }).eq("user_id", user_id).eq("chave", chave).eq("canal", canal);
}

Deno.serve(async (req) => {
  const cron = await secret("cron_secret");
  if (!cron || req.headers.get("x-cron-secret") !== cron) return new Response("não autorizado", { status: 401 });

  // chaves das notificações: criadas na primeira execução e guardadas no cofre
  let vPub = await secret("vapid_public"), vPriv = await secret("vapid_private");
  if (!vPub || !vPriv) {
    const k = webpush.generateVAPIDKeys();
    await sb.rpc("app_secret_set", { n: "vapid_public", v: k.publicKey });
    await sb.rpc("app_secret_set", { n: "vapid_private", v: k.privateKey });
    vPub = k.publicKey; vPriv = k.privateKey;
  }
  webpush.setVapidDetails("mailto:" + ((await secret("contato_email")) || "contato@lembraai.app"), vPub, vPriv);
  const resendKey = await secret("resend_key"), emailFrom = (await secret("email_from")) || "Lembra Aí <onboarding@resend.dev>";
  const waToken = await secret("wa_token"), waPhone = await secret("wa_phone_id"), waTpl = (await secret("wa_template")) || "lembrete";
  const appUrl = (await secret("app_url")) || "";

  const agora = Date.now(), de = agora - JANELA_MIN * 60000;
  const { data: estados } = await sb.from("app_state").select("user_id,data");
  const { data: perfis } = await sb.from("profiles").select("id,nome,email,whatsapp,canais");
  const { data: ass } = await sb.from("assinaturas").select("user_id,status,teste_fim");
  const ok = new Set((ass || []).filter((a) => a.status === "ativa" || Date.parse(a.teste_fim) > agora).map((a) => a.user_id));
  const P = new Map((perfis || []).filter((p) => ok.has(p.id)).map((p) => [p.id, p]));
  const resumo = { pessoas: 0, alertas: 0, push: 0, email: 0, whatsapp: 0, erros: 0 };

  for (const st of estados || []) {
    const p = P.get(st.user_id);
    if (!p || !st.data) continue;
    const alertas = alertasDe(st.data, de, agora);
    if (!alertas.length) continue;
    resumo.pessoas++;
    const c = p.canais || { alarme: true, whats: true, email: false };
    const { data: subs } = await sb.from("push_subs").select("id,endpoint,p256dh,auth").eq("user_id", st.user_id);

    for (const a of alertas) {
      resumo.alertas++;
      // 1) notificação no celular
      if (c.alarme !== false && subs?.length && await marcar(st.user_id, a.chave, "push")) {
        let ok = 0, err = "";
        for (const s of subs) {
          try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
              JSON.stringify({ title: a.titulo, body: a.corpo, url: a.url, tag: a.chave, conta: a.conta }), { TTL: 3600, urgency: "high" });
            ok++;
          } catch (e) {
            // deno-lint-ignore no-explicit-any
            const code = (e as any)?.statusCode;
            if (code === 404 || code === 410) await sb.from("push_subs").delete().eq("id", s.id);
            err = String(code || e);
          }
        }
        await status(st.user_id, a.chave, "push", ok ? "enviado" : "erro", err);
        ok ? resumo.push++ : resumo.erros++;
      }
      if (a.soApp) continue; // assinaturas: só pelo app

      // 2) e-mail
      if (c.email && p.email && resendKey && await marcar(st.user_id, a.chave, "email")) {
        const link = appUrl ? `${appUrl}${a.url}` : "";
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: emailFrom, to: p.email, subject: a.titulo.replace(/^\S+\s/, ""),
            html: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#111"><p style="font-size:20px;font-weight:700;margin:0 0 8px">${a.titulo}</p><p style="margin:0 0 16px">${a.corpo.replace(/Toque para.*$/, "")}</p>${link ? `<a href="${link}" style="background:#111;color:#fff;padding:12px 18px;border-radius:12px;text-decoration:none;font-weight:700">Abrir no Lembra Aí</a>` : ""}<p style="color:#777;font-size:12px;margin-top:24px">Você recebe este e-mail porque ativou lembretes por e-mail no Lembra Aí.</p></div>`,
          }),
        });
        await status(st.user_id, a.chave, "email", r.ok ? "enviado" : "erro", r.ok ? "" : await r.text());
        r.ok ? resumo.email++ : resumo.erros++;
      }

      // 3) WhatsApp (API oficial; precisa de modelo de mensagem aprovado pela Meta)
      if (c.whats !== false && p.whatsapp && waToken && waPhone && await marcar(st.user_id, a.chave, "whatsapp")) {
        const r = await fetch(`https://graph.facebook.com/v21.0/${waPhone}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${waToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp", to: "55" + p.whatsapp, type: "template",
            template: { name: waTpl, language: { code: "pt_BR" }, components: [{ type: "body", parameters: [{ type: "text", text: a.titulo.replace(/^\S+\s/, "") }, { type: "text", text: a.corpo.replace(/ ?Toque para.*$/, "") || "-" }] }] },
          }),
        });
        await status(st.user_id, a.chave, "whatsapp", r.ok ? "enviado" : "erro", r.ok ? "" : await r.text());
        r.ok ? resumo.whatsapp++ : resumo.erros++;
      }
    }
  }
  return new Response(JSON.stringify(resumo), { headers: { "Content-Type": "application/json" } });
});
