// Lembra Aí — avisos da agenda (roda a cada minuto pelo agendador)
// Profissional: novo agendamento e cancelamento (celular, e-mail, WhatsApp).
// Cliente: confirmação por e-mail, aviso de cancelamento e lembretes 24h e 2h antes.
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TZ = "America/Sao_Paulo";
const JANELA = 15 * 60000;
const secret = async (n: string): Promise<string | null> => ((await sb.rpc("app_secret", { n })).data as string) || null;
const hm = (d: string) => new Date(d).toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const dia = (d: string) => new Date(d).toLocaleDateString("pt-BR", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" }).replace(".", "");
const quando = (d: string) => {
  const k = (x: number | string) => new Date(x).toLocaleDateString("en-CA", { timeZone: TZ });
  const h = k(Date.now()), a = k(Date.now() + 864e5), x = k(d);
  return x === h ? `hoje às ${hm(d)}` : x === a ? `amanhã às ${hm(d)}` : `${dia(d)} às ${hm(d)}`;
};
const esc = (s: string) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

type Msg = { user: string | null; email?: string | null; tel?: string | null; chave: string; titulo: string; corpo: string; url: string; canais: { push: boolean; email: boolean; whats: boolean } };

Deno.serve(async (req) => {
  const cron = await secret("cron_secret");
  if (!cron || req.headers.get("x-cron-secret") !== cron) return new Response("não autorizado", { status: 401 });
  let vPub = await secret("vapid_public"), vPriv = await secret("vapid_private");
  if (!vPub || !vPriv) {
    const k = webpush.generateVAPIDKeys();
    await sb.rpc("app_secret_set", { n: "vapid_public", v: k.publicKey });
    await sb.rpc("app_secret_set", { n: "vapid_private", v: k.privateKey });
    vPub = k.publicKey; vPriv = k.privateKey;
  }
  webpush.setVapidDetails("mailto:" + ((await secret("contato_email")) || "contato@lembraai.app"), vPub!, vPriv!);
  const resendKey = await secret("resend_key"), emailFrom = (await secret("email_from")) || "Lembra Aí <onboarding@resend.dev>";
  const waToken = await secret("wa_token"), waPhone = await secret("wa_phone_id"), waTpl = (await secret("wa_template")) || "lembrete";
  const appUrl = (await secret("app_url")) || "";
  const agora = Date.now(), desde = new Date(agora - JANELA).toISOString();

  // agendamentos relevantes: criados/alterados há pouco, ou começando nas próximas 25h
  const [{ data: recentes }, { data: proximos }] = await Promise.all([
    sb.from("agendamentos").select("*").gte("atualizado_em", desde),
    sb.from("agendamentos").select("*").eq("status", "confirmado").gte("inicio", new Date(agora).toISOString()).lte("inicio", new Date(agora + 25 * 3600e3).toISOString()),
  ]);
  const todos = new Map([...(recentes || []), ...(proximos || [])].map((a) => [a.id, a]));
  if (!todos.size) return new Response(JSON.stringify({ ok: true, alertas: 0 }));
  const profIds = [...new Set([...todos.values()].map((a) => a.prof_id))];
  const userIds = [...new Set([...todos.values()].flatMap((a) => [a.prof_id, a.cliente_id]).filter(Boolean))];
  const [{ data: profs }, { data: perfis }, { data: ass }] = await Promise.all([
    sb.from("profissionais").select("id,nome,slug,endereco").in("id", profIds),
    sb.from("profiles").select("id,nome,email,whatsapp,canais").in("id", userIds),
    sb.from("assinaturas").select("user_id,status,teste_fim").in("user_id", profIds),
  ]);
  const P = new Map((profs || []).map((p) => [p.id, p])), U = new Map((perfis || []).map((p) => [p.id, p]));
  const ativo = new Set((ass || []).filter((a) => a.status === "ativa" || Date.parse(a.teste_fim) > agora).map((a) => a.user_id));

  const msgs: Msg[] = [];
  for (const a of todos.values()) {
    const p = P.get(a.prof_id);
    if (!p || !ativo.has(a.prof_id)) continue;
    const pu = U.get(a.prof_id), cu = a.cliente_id ? U.get(a.cliente_id) : null;
    const pc = pu?.canais || {}, cc = cu?.canais || {};
    const urlCli = `?p=${p.slug}#meus`, urlPro = `#ag-${a.id}`;
    const recente = Date.parse(a.atualizado_em) > agora - JANELA;
    const novo = recente && a.status === "confirmado" && Date.parse(a.criado_em) > agora - JANELA;
    if (novo && a.origem === "link") {
      msgs.push({ user: a.prof_id, email: pu?.email, tel: pu?.whatsapp, chave: `novo|${a.id}`, titulo: `Novo agendamento: ${a.cliente_nome}`, corpo: `${a.servico_nome} · ${quando(a.inicio)}`, url: urlPro, canais: { push: true, email: pc.email !== false, whats: pc.whats !== false } });
      if (cu) msgs.push({ user: a.cliente_id, email: cu.email, chave: `conf|${a.id}`, titulo: `Horário confirmado com ${p.nome}`, corpo: `${a.servico_nome} · ${quando(a.inicio)}${p.endereco ? " · " + p.endereco : ""}`, url: urlCli, canais: { push: false, email: true, whats: false } });
    }
    if (recente && a.status === "cancelado") {
      if (a.cancelado_por === "cliente") msgs.push({ user: a.prof_id, email: pu?.email, tel: pu?.whatsapp, chave: `canc|${a.id}`, titulo: `Cancelado: ${a.cliente_nome}`, corpo: `${a.servico_nome} · ${quando(a.inicio)}. O horário voltou a ficar livre no seu link.`, url: urlPro, canais: { push: true, email: pc.email !== false, whats: pc.whats !== false } });
      else if (cu) msgs.push({ user: a.cliente_id, email: cu.email, tel: cu.whatsapp, chave: `canc|${a.id}`, titulo: `${p.nome} cancelou seu horário`, corpo: `${a.servico_nome} · ${quando(a.inicio)}. Toque para marcar outro horário.`, url: `?p=${p.slug}`, canais: { push: true, email: true, whats: cc.whats !== false } });
    }
    if (a.status === "confirmado" && cu) {
      const falta = Date.parse(a.inicio) - agora, criadoHa = agora - Date.parse(a.criado_em);
      if (falta <= 24 * 3600e3 && falta > 23 * 3600e3 && criadoHa > 3600e3) msgs.push({ user: a.cliente_id, email: cu.email, tel: cu.whatsapp, chave: `l24|${a.id}`, titulo: `Lembrete: amanhã às ${hm(a.inicio)}`, corpo: `${a.servico_nome} com ${p.nome}${p.endereco ? " · " + p.endereco : ""}`, url: urlCli, canais: { push: true, email: true, whats: cc.whats !== false } });
      if (falta <= 2 * 3600e3 && falta > 3600e3 && criadoHa > 3600e3) msgs.push({ user: a.cliente_id, email: cu.email, chave: `l2|${a.id}`, titulo: `Daqui a pouco: ${hm(a.inicio)}`, corpo: `${a.servico_nome} com ${p.nome}${p.endereco ? " · " + p.endereco : ""}`, url: urlCli, canais: { push: true, email: false, whats: false } });
    }
  }

  const r = { alertas: msgs.length, push: 0, email: 0, whatsapp: 0, erros: 0 };
  const marcar = async (user_id: string, chave: string, canal: string) => {
    const { data, error } = await sb.from("envios").insert({ user_id, chave, canal }).select("chave");
    return !error && !!data?.length;
  };
  const status = async (user_id: string, chave: string, canal: string, st: string, det = "") => {
    await sb.from("envios").update({ status: st, detalhe: det.slice(0, 500) }).eq("user_id", user_id).eq("chave", chave).eq("canal", canal);
  };
  for (const m of msgs) {
    if (!m.user) continue;
    if (m.canais.push && await marcar(m.user, m.chave, "push")) {
      const { data: subs } = await sb.from("push_subs").select("id,endpoint,p256dh,auth").eq("user_id", m.user);
      let ok = 0, err = "";
      for (const s of subs || []) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: m.titulo, body: m.corpo, url: m.url, tag: m.chave }), { TTL: 3600, urgency: "high" });
          ok++;
        } catch (e) {
          // deno-lint-ignore no-explicit-any
          const code = (e as any)?.statusCode;
          if (code === 404 || code === 410) await sb.from("push_subs").delete().eq("id", s.id);
          err = String(code || e);
        }
      }
      await status(m.user, m.chave, "push", ok ? "enviado" : "sem aparelho", err);
      if (ok) r.push++;
    }
    if (m.canais.email && m.email && resendKey && await marcar(m.user, m.chave, "email")) {
      const link = appUrl ? appUrl + m.url : "";
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: emailFrom, to: m.email, subject: m.titulo, html: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#111;max-width:520px"><p style="font-size:20px;font-weight:700;margin:0 0 8px">${esc(m.titulo)}</p><p style="margin:0 0 18px">${esc(m.corpo)}</p>${link ? `<a href="${link}" style="background:#111;color:#fff;padding:12px 18px;border-radius:12px;text-decoration:none;font-weight:700">Abrir</a>` : ""}<p style="color:#777;font-size:12px;margin-top:24px">Aviso automático do Lembra Aí.</p></div>` }),
      });
      await status(m.user, m.chave, "email", res.ok ? "enviado" : "erro", res.ok ? "" : await res.text());
      res.ok ? r.email++ : r.erros++;
    }
    if (m.canais.whats && m.tel && waToken && waPhone && await marcar(m.user, m.chave, "whatsapp")) {
      const res = await fetch(`https://graph.facebook.com/v21.0/${waPhone}/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${waToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: "55" + m.tel, type: "template", template: { name: waTpl, language: { code: "pt_BR" }, components: [{ type: "body", parameters: [{ type: "text", text: m.titulo }, { type: "text", text: m.corpo }] }] } }),
      });
      await status(m.user, m.chave, "whatsapp", res.ok ? "enviado" : "erro", res.ok ? "" : await res.text());
      res.ok ? r.whatsapp++ : r.erros++;
    }
  }
  return new Response(JSON.stringify(r), { headers: { "Content-Type": "application/json" } });
});
