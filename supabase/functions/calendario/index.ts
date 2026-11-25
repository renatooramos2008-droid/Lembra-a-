// Lembra Aí — agenda do profissional no Calendário do iPhone / Google Agenda (assinatura .ics)
import { createClient } from "jsr:@supabase/supabase-js@2";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const z = (d: string | number) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const tx = (s: string) => String(s || "").replace(/\\/g, "\\\\").replace(/[,;]/g, (c) => "\\" + c).replace(/\r?\n/g, "\\n");
const dobra = (l: string) => { const out = []; let s = l; while (s.length > 74) { out.push(s.slice(0, 74)); s = " " + s.slice(74); } out.push(s); return out.join("\r\n"); };
Deno.serve(async (req) => {
  const t = new URL(req.url).searchParams.get("t") || "";
  if (!/^[0-9a-f-]{36}$/i.test(t)) return new Response("link inválido", { status: 404 });
  const { data: p } = await sb.from("profissionais").select("id,nome,endereco").eq("ical_token", t).maybeSingle();
  if (!p) return new Response("link inválido", { status: 404 });
  const { data: ags } = await sb.from("agendamentos").select("id,inicio,fim,cliente_nome,cliente_tel,servico_nome,obs,status,criado_em,atualizado_em")
    .eq("prof_id", p.id).in("status", ["confirmado", "concluido"]).gte("inicio", new Date(Date.now() - 60 * 864e5).toISOString()).order("inicio").limit(2000);
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Lembra Ai//Agenda//PT-BR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:" + tx("Agenda · " + p.nome), "X-WR-TIMEZONE:America/Sao_Paulo", "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M"];
  for (const a of ags || []) {
    L.push("BEGIN:VEVENT", "UID:" + a.id + "@lembraai", "DTSTAMP:" + z(a.atualizado_em), "DTSTART:" + z(a.inicio), "DTEND:" + z(a.fim),
      dobra("SUMMARY:" + tx(`${a.cliente_nome} · ${a.servico_nome}`)),
      dobra("DESCRIPTION:" + tx([a.cliente_tel ? "Celular: " + a.cliente_tel : "", a.obs ? "Obs.: " + a.obs : ""].filter(Boolean).join("\n"))),
      ...(p.endereco ? [dobra("LOCATION:" + tx(p.endereco))] : []), "BEGIN:VALARM", "TRIGGER:-PT30M", "ACTION:DISPLAY", "DESCRIPTION:Atendimento", "END:VALARM", "END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return new Response(L.join("\r\n") + "\r\n", { headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-cache" } });
});
