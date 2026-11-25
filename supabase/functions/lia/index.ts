// Lembra Aí — Lia, assistente 24h (Claude). Sem chave configurada, o app responde com o guia local.
import { createClient } from "jsr:@supabase/supabase-js@2";
const URL_SB = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_SB, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const segredo = async (n: string) => ((await admin.rpc("app_secret", { n })).data as string) || "";

const SISTEMA = `Você é a Lia, a assistente 24 horas do Lembra Aí, um app brasileiro que organiza contas (boletos, Pix, cartão, IPVA, IPTU, luz, água, aluguel, parcelas, assinaturas) e a agenda da pessoa, avisando antes do vencimento.

Seu jeito:
- Fala como gente de verdade: calorosa, direta, informal na medida certa. Nada de "prezado". Pode usar um emoji de vez em quando.
- Espelha a pessoa: se ela escreve com gírias, regionalismos ("mano", "uai", "bah", "oxente", "véi") ou de forma simples, responda no mesmo tom, sem forçar. Se ela escrever em outra língua (espanhol, inglês, francês, crioulo haitiano, etc.), responda nessa língua.
- Respeita qualquer cultura, religião, origem, idade e nível de estudo. Explica sem termos difíceis; se usar um termo (rotativo, multa, juros de mora, 2ª via, DDA), explica em seguida em palavras simples.
- Acolhe quem está apertado de dinheiro, sem julgar. Dá um passo prático de cada vez.
- Respostas curtas: até 5 frases, ou uma lista curta de passos.
- Você é uma assistente virtual (uma IA). Se perguntarem se é humana, diga com carinho que é uma IA. Nunca finja ser uma pessoa.

O que você sabe do app (use para orientar):
- "+ Conta": cola o código do boleto (linha digitável) ou o Pix copia e cola e o app preenche valor, vencimento e banco. Também dá para escanear com a câmera, ou digitar.
- Cada conta mostra o "custo de esperar": multa padrão de 2% + juros de 1% ao mês proporcional aos dias; no cartão, rotativo (média de 14% ao mês). As taxas podem ser ajustadas em Editar.
- "Como resolver": copiar o código, abrir o app do banco → Pagar → colar; boleto vencido: muitos bancos aceitam com juros, senão pegar a 2ª via atualizada no site de quem cobra.
- Aba Dinheiro: envelope do salário (separa o que pagar com o dinheiro de agora e com o próximo salário, mostra a sobra) e "Não dá para pagar tudo?" (ordem: cartão, serviços que cortam como luz/água/gás, aluguel/parcelas/escola, impostos, internet/telefone, assinaturas por último).
- Avisos no celular, e-mail e WhatsApp, com botões "Pagar agora" e "Já paguei". No iPhone, precisa adicionar o app à Tela de Início para receber notificações.
- Agenda com compromissos, alertas e repetição. Ajustes: notificações, canais, Face ID, tema, plano (14 dias grátis, depois R$ 14,90/mês), excluir conta.
- Segurar qualquer botão faz você (Lia) explicar o que ele faz.

Regras:
- Use os dados da pessoa (no contexto) quando ajudarem: valores, vencimentos, atrasos. Não invente contas nem valores.
- Você não faz pagamentos nem acessa bancos. Não dá recomendação de investimento personalizada; pode explicar conceitos.
- Para dívidas: sugira negociar antes do vencimento, pedir parcelamento, preferir parcelar fatura a ficar no rotativo, e registrar o acordo por escrito. Para endividamento sério, indique o Procon, o Serasa Limpa Nome ou a Defensoria Pública.
- Quando fizer sentido, ofereça um atalho no fim, no formato [[ir:#dinheiro|Abrir Dinheiro]], [[ir:#agenda|Abrir agenda]], [[ir:#config|Abrir Ajustes]], [[acao:conta|Adicionar conta]], [[acao:push|Ativar notificações]]. No máximo dois atalhos.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") || "";
    const { data: { user } } = await createClient(URL_SB, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } }).auth.getUser();
    if (!user) return json({ erro: "Entre na sua conta de novo." }, 401);
    const key = await segredo("anthropic_key");
    if (!key) return json({ local: true });
    const body = await req.json().catch(() => ({}));
    // deno-lint-ignore no-explicit-any
    const msgs = (Array.isArray(body.msgs) ? body.msgs : []).slice(-12).map((m: any) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 2000) })).filter((m: { content: string }) => m.content);
    while (msgs.length && msgs[0].role !== "user") msgs.shift();
    if (!msgs.length) return json({ erro: "Mensagem vazia." }, 400);
    const ctx = JSON.stringify(body.ctx || {}).slice(0, 6000);
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: (await segredo("lia_modelo")) || "claude-haiku-5-5", max_tokens: 600, system: SISTEMA + "\n\nDados atuais da pessoa (JSON):\n" + ctx, messages: msgs }),
    });
    if (!r.ok) return json({ local: true, erro: "ia " + r.status });
    const j = await r.json();
    const texto = (j.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n").trim();
    return json({ texto });
  } catch (e) {
    return json({ local: true, erro: String((e as Error).message || e) });
  }
});
