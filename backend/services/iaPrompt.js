// Prompts da IA. Ficam separados de services/ia.js para dar para ajustar o
// texto sem mexer nas chamadas HTTP dos provedores.
//
// Dois modos:
//   montarPromptFoto()   - analisa uma foto (sinais visuais)
//   montarPromptRotina() - analisa só os números da rotina contra a espécie e
//                          a finalidade, sem foto nenhuma
//
// Três regras que os dois carregam, por honestidade do TCC:
//  - a IA só vê o que mandamos. O projeto não tem pH (nem sensor, nem meta)
//    e não mede luminosidade, então ela não pode falar de nenhum dos dois;
//  - nada sobre concentração de princípio ativo, potência medicinal ou efeito
//    terapêutico. Isso não se mede por foto nem por umidade — e numa banca é
//    exatamente o tipo de afirmação que alguém derruba;
//  - a finalidade entra pelo lado HORTÍCOLA: "a camomila se usa pela flor,
//    então priorize floração". Não pelo lado farmacológico.

const { LIMITES } = require("./configDispositivo");

// O JSON esperado de volta. Vira responseSchema no Gemini e
// output_config.format no Claude, então precisa caber no subconjunto de JSON
// Schema que os dois aceitam: sem minimum/maximum, sem maxLength.
const ESQUEMA_RESPOSTA = {
  type: "object",
  properties: {
    health_status: { type: "string", enum: ["saudavel", "atencao"] },
    analysis_text: { type: "string" },
    suggestion: {
      type: ["object", "null"],
      properties: {
        message: { type: "string" },
        growth_pct: { type: "number" },
        health_pct: { type: "number" },
        config: {
          type: "object",
          properties: {
            humidity_target: { type: "number" },
            light_hours: { type: "number" },
            vent_min_por_hora: { type: "number" },
            temp_max: { type: "number" },
            nutri_s: { type: "number" },
            water_interval_h: { type: "number" },
            uv_min_dia: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      required: ["message", "growth_pct", "health_pct"],
      additionalProperties: false,
    },
  },
  required: ["health_status", "analysis_text", "suggestion"],
  additionalProperties: false,
};

/* Esquema do modo ROTINA: igual ao de cima, mas a config é a rotina INTEIRA,
   com os 7 campos obrigatórios. (O projeto não tem mais pH: o campo saiu.) Deixando a IA escolher quais campos mandar,
   ela escrevia "corrigimos pH, umidade e temperatura" e esquecia a umidade
   no config. Obrigando todos, cada parâmetro sai avaliado; o servidor
   (services/autoAjuste.js) compara com a estação e aplica só o que mudou. */
const CAMPOS_ROTINA = [
  "light_hours",
  "humidity_target",
  "water_interval_h",
  "temp_max",
  "vent_min_por_hora",
  "nutri_s",
  "uv_min_dia",
];
const ESQUEMA_ROTINA = JSON.parse(JSON.stringify(ESQUEMA_RESPOSTA));
ESQUEMA_ROTINA.properties.suggestion.required = ["message", "growth_pct", "health_pct", "config"];
ESQUEMA_ROTINA.properties.suggestion.properties.config.required = CAMPOS_ROTINA;

/* Esquema do modo FOTO: o de cima mais o anti-pragas. Obrigatório aqui (a IA
   sempre diz algo sobre pragas) e ausente da rotina, que não vê foto. */
const ESQUEMA_FOTO = JSON.parse(JSON.stringify(ESQUEMA_RESPOSTA));
ESQUEMA_FOTO.properties.pragas = { type: "string", enum: ["sim", "nao", "incerto"] };
ESQUEMA_FOTO.properties.pragas_descricao = { type: ["string", "null"] };
ESQUEMA_FOTO.required = ESQUEMA_RESPOSTA.required.concat(["pragas", "pragas_descricao"]);

/* Com o quadro da iluminação (IMAGEM 2) a resposta traz também o nível de luz. */
const ESQUEMA_FOTO_LUZ = JSON.parse(JSON.stringify(ESQUEMA_FOTO));
ESQUEMA_FOTO_LUZ.properties.luz_nivel = { type: "string", enum: ["pouca", "boa", "muita", "incerto"] };
ESQUEMA_FOTO_LUZ.properties.luz_descricao = { type: "string" };
ESQUEMA_FOTO_LUZ.required = ESQUEMA_FOTO.required.concat(["luz_nivel", "luz_descricao"]);

function ou(valor, alternativa) {
  return valor === null || valor === undefined || valor === "" ? alternativa : valor;
}

function horaLocal() {
  return new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

// Bloco compartilhado: quem é a planta e para que o usuário a está cultivando.
function blocoPlanta(estacao) {
  return `## A planta
- Espécie declarada pelo usuário: ${ou(estacao.plant, "não informada")}
- **Finalidade de cultivo declarada:** ${ou(estacao.tag, "não informada")}
- Estação: ${ou(estacao.name, "sem nome")}
- Hora local: ${horaLocal()} (America/Sao_Paulo)

A finalidade é o que o usuário espera colher. Use isso para saber QUAL PARTE da
planta importa (flor, folha, raiz) e, daí, o que a rotina deveria favorecer.
Exemplo: camomila se usa pela flor, então uma rotina que faz a planta vegetar
sem florescer não serve, mesmo que a planta esteja verde e bonita.

LIMITE: não afirme nada sobre concentração de princípio ativo, potência
medicinal ou efeito terapêutico. Você não mede isso. Fale de horticultura
(floração, vigor, porte, estresse), nunca de farmacologia.`;
}

function blocoConfig(c) {
  return `## Rotina configurada agora
- Irrigação: liga abaixo de ${ou(c.umid_liga, "?")}% de umidade no substrato, desliga em ${ou(c.umid_desliga, "?")}%
- Fotoperíodo (LED de cultivo): ${ou(c.luz_on, "?")} às ${ou(c.luz_off, "?")}
- Ventilação: ${ou(c.vent_min_por_hora, "?")} min por hora, e sempre que passar de ${ou(c.temp_max, "?")} °C
- Nutriente: ${ou(c.nutri_s, "?")} s de dosagem por dia, às ${ou(c.nutri_hora, "?")}
- Luz UV: até ${ou(c.uv_min_dia, "?")} min por dia. A UV está no MESMO relé dos
  ventiladores: só liga junto com eles. A ventilação programada fica dentro do
  fotoperíodo e para quando o orçamento de UV do dia acaba; a ventilação por
  temperatura liga a qualquer hora e também conta como UV.`;
}

function blocoLeitura(l) {
  const umidade =
    !l || l.humidity === null || l.humidity === undefined ? "sem leitura" : `${Math.round(Number(l.humidity))}%`;
  /* Sem o sensor da horta, vai a temperatura do ar de São Paulo (internet),
     dita como tal: é referência do clima, não medição da horta. */
  const temp =
    l && l.temperature !== null && l.temperature !== undefined
      ? `${Number(l.temperature).toFixed(1)} °C`
      : l && Number.isFinite(Number(l.temperatura_externa)) && l.temperatura_externa !== null
        ? `sensor da horta sem leitura; em São Paulo agora faz ${Number(l.temperatura_externa).toFixed(1)} °C (internet, ar externo)`
        : "sem leitura";
  return `## Leitura dos sensores
- Umidade do substrato: ${umidade}
- Temperatura do ar: ${temp}

Só existem esses dois sensores. NÃO há sensor de pH, de luminosidade, de
condutividade nem de nutrientes — não mencione nenhum deles.`;
}

function blocoLimites(comRotinaCompleta) {
  const base = `  - humidity_target: ${LIMITES.humidity_target[0]} a ${LIMITES.humidity_target[1]}
  - light_hours: ${LIMITES.light_hours[0]} a ${LIMITES.light_hours[1]}
  - vent_min_por_hora: ${LIMITES.vent_min_por_hora[0]} a ${LIMITES.vent_min_por_hora[1]}
  - temp_max: ${LIMITES.temp_max[0]} a ${LIMITES.temp_max[1]}
  - nutri_s: ${LIMITES.nutri_s[0]} a ${LIMITES.nutri_s[1]}
  - uv_min_dia: ${LIMITES.uv_min_dia[0]} a ${LIMITES.uv_min_dia[1]}`;
  if (!comRotinaCompleta) return base;
  return `${base}
  - water_interval_h: ${LIMITES.water_interval_h[0]} a ${LIMITES.water_interval_h[1]}`;
}

// ------------------------------------------------- modo foto (análise visual)
const RESPOSTA_LUZ = "\n- luz_nivel: \"pouca\", \"boa\", \"muita\" ou \"incerto\", pela IMAGEM 2.\n- luz_descricao: uma frase de até 100 caracteres explicando o nível de luz\n  (ex.: \"Planta bem iluminada, sem sombras fortes nem áreas estouradas\").";

function blocoLuz() {
  return `
## IMAGEM 2: iluminação
Você recebeu DUAS imagens. A primeira é a foto de saúde (flash, LED apagado).
A SEGUNDA foi tirada ~20 s antes, SEM flash, com o LED de cultivo (roxo)
ACESO e com a exposição da câmera TRAVADA (sem correção automática de
brilho). Use a segunda só para julgar QUANTA LUZ a planta está recebendo:
- muito escura, planta mal visível => pouca luz;
- planta bem iluminada, detalhes visíveis, sem áreas estouradas => boa luz;
- muito clara, áreas brancas estouradas, folhas lavadas => muita luz.
Considere a espécie: ervas de sol pleno pedem mais luz que folhosas de sombra.
O tom roxo é normal (LED de cultivo) e não indica problema. Se a imagem 2
não permitir julgar (lente tampada, planta fora do quadro), use "incerto".
Não use a imagem 2 para avaliar saúde nem pragas: isso é da imagem 1.`;
}
function montarPromptFoto({ estacao, leitura, config, comLuz = false }) {
  return `Você é especialista em fisiologia vegetal e cultivo semi-hidropônico de plantas medicinais. Avalie a foto desta planta e responda em JSON.

${blocoPlanta(estacao)}

${blocoLeitura(leitura)}

${blocoConfig(config || {})}

## Sobre a foto
Foi tirada com o LED de cultivo (roxo) APAGADO e flash branco da câmera. As
cores são reais: pode confiar em tons de verde, amarelo e marrom.${comLuz ? blocoLuz() : ""}

## O que avaliar
Apenas SINAIS VISUAIS: cor das folhas, murcha, manchas, bordas secas, pragas
visíveis, porte, vigor e — se a finalidade pedir — presença e quantidade de flores.

A planta recebe luz UV de propósito (estresse leve para estimular compostos de
defesa). Sinais de UV DEMAIS: folhas novas bronzeadas, avermelhadas ou com
manchas esbranquiçadas/prateadas na face de cima, bordas enroladas para cima,
crescimento travado. Se vir isso, o ajuste certo é reduzir uv_min_dia (não mexa
na ventilação por causa disso).

Regras:
1. Não invente medição que não recebeu.
2. Se a foto estiver escura, embaçada, fora de foco ou sem planta visível, use
   health_status "atencao", diga isso em analysis_text e devolva suggestion: null.
   NÃO descreva uma planta que você não consegue ver.
3. Não repita os números dos sensores em analysis_text — o app já os mostra ao lado.

## Anti-pragas
Procure ativamente sinais de PRAGA: insetos (pulgões, cochonilhas, moscas-
brancas, tripes, lagartas), ácaros e suas teias finas, ovos, folhas roídas ou
furadas, trilhas/minas nas folhas, melada pegajosa, fumagina (fuligem preta).
Doença por fungo (oídio, manchas) não é praga; vale citar em analysis_text.

## Resposta
- health_status: "saudavel" se não houver sinal visual preocupante; "atencao" se houver.
  Praga visível conta como "atencao".
- analysis_text: até 200 caracteres, em português do Brasil, falando direto com
  quem cultiva. Diga o que você viu e, se for o caso, o que fazer.
- pragas: "sim" se você VÊ sinal de praga; "nao" se a planta está bem visível e
  não há sinal; "incerto" se a foto não deixa avaliar (escura, desfocada,
  planta pequena demais ou fora do quadro). Na dúvida entre "sim" e "nao", use
  "incerto" — não invente praga.
- pragas_descricao: com "sim", qual praga e onde, em até 100 caracteres (ex.:
  "Pulgões verdes no verso das folhas novas"); com "nao" ou "incerto", null.${comLuz ? RESPOSTA_LUZ : ""}
- suggestion: quase sempre null. Só proponha algo se um sinal VISUAL indicar que
  vale mudar o ambiente, e só UM ajuste por vez:
  - message: a justificativa, em uma frase, dizendo o que você viu.
  - growth_pct e health_pct: ganho esperado, de 0 a 30. Seja conservador.
  - config: só os campos que mudam, dentro destes limites:
${blocoLimites()}

Responda SOMENTE o JSON, sem texto antes ou depois.`;
}

// --------------------------------------- modo rotina (sem foto, só os números)
function num(v) {
  return v === null || v === undefined || v === "" ? "?" : Number(v);
}

function montarPromptRotina({ estacao, leitura, config }) {
  return `Você é especialista em fisiologia vegetal e cultivo semi-hidropônico de plantas medicinais. O usuário acabou de configurar a rotina de cultivo abaixo. Avalie se ela faz sentido para esta espécie e esta finalidade e, se não fizer, devolva a rotina corrigida. Responda em JSON.

Você NÃO recebeu foto nesta avaliação. Julgue apenas os números da rotina.

${blocoPlanta(estacao)}

${blocoConfig(config || {})}
- Luz diária: ${num(estacao.light_hours)} h · umidade alvo: ${num(estacao.humidity_target)}%
- Intervalo de rega desejado: a cada ${num(estacao.water_interval_h)} h

${blocoLeitura(leitura)}

## O que avaliar
A rotina serve para esta espécie, considerando a finalidade declarada?

Pense em:
- **Fotoperíodo** — as horas de luz batem com o que a espécie precisa para o
  estágio que interessa? Camomila e outras que se usam pela flor precisam de dia
  longo para florescer; folhosas como hortelã rendem mais folha com dia mais curto.
- **Umidade e rega** — está encharcando ou secando demais para esta espécie?
  Aromáticas mediterrâneas não gostam de substrato sempre úmido.
- **Temperatura máxima** antes de ligar a ventilação — está alta demais para a
  espécie aguentar sem estresse?
- **Ventilação** — pouca favorece fungo em ambiente úmido; muita resseca.
- **Nutriente** — a dose diária é compatível com o porte da planta?
- **Luz UV (uv_min_dia)** — é um estressor usado de propósito: em dose curta a
  planta produz mais flavonoides e óleos essenciais; em dose alta queima folha.
  Estudos com ervas medicinais mostram ganho com 15 a 60 min por dia; acima de
  ~120 min o risco de dano cresce. Folhosas tenras e mudas pedem menos; ervas
  aromáticas de sol pleno toleram mais. 0 desliga a UV, mas também desliga a
  ventilação programada (só a por temperatura continua) — em ambiente úmido,
  prefira uma dose baixa a zero.

Regras:
1. Não invente medição que não recebeu. O projeto NÃO tem pH (nem sensor nem
   meta): não fale de pH em nenhuma hipótese. Também não cite luminosidade.
2. Se a rotina está adequada, diga isso e devolva suggestion: null. Não invente
   problema para parecer útil — pequenas diferenças de gosto não contam.
3. Se a espécie declarada não for uma planta reconhecível, ou a finalidade não
   fizer sentido para ela, diga isso em analysis_text com health_status
   "atencao" e devolva suggestion: null — não adivinhe uma rotina.
4. Se a rotina está inadequada, CORRIJA TUDO DE UMA VEZ: suggestion.config é
   a ROTINA COMPLETA recomendada, com os 7 campos (light_hours,
   humidity_target, water_interval_h, temp_max, vent_min_por_hora, nutri_s,
   uv_min_dia). Para cada um: se o valor atual já é bom para esta espécie e
   finalidade, repita o valor atual; se não é, ponha o valor ideal. O app
   compara e aplica só o que mudou.
5. Coerência: todo parâmetro que você citar como errado em analysis_text ou em
   message PRECISA estar com valor diferente do atual em config. Se escreveu
   "a umidade está alta", humidity_target tem que mudar.

## Resposta
- health_status: "saudavel" se a rotina está adequada; "atencao" se há algo a corrigir.
- analysis_text: até 200 caracteres, em português do Brasil, falando com quem
  cultiva. Se houver problema, diga o que está errado e por quê, ligando à
  espécie ou à finalidade. Ex.: "4 h de luz é pouco para a camomila florescer, e
  95% de umidade favorece fungo na raiz."
- suggestion: null se a rotina está boa. Se não está:
  - message: uma frase dizendo como a rotina corrigida favorece esta espécie e
    esta finalidade.
  - growth_pct e health_pct: ganho esperado, de 0 a 30. Seja conservador.
  - config: a rotina completa (os 7 campos), dentro destes limites:
${blocoLimites(true)}

Responda SOMENTE o JSON, sem texto antes ou depois.`;
}

module.exports = {
  montarPromptFoto,
  montarPromptRotina,
  // nome antigo, mantido para não quebrar quem já importava
  montarPrompt: montarPromptFoto,
  ESQUEMA_RESPOSTA,
  ESQUEMA_ROTINA,
  ESQUEMA_FOTO,
  ESQUEMA_FOTO_LUZ,
  CAMPOS_ROTINA,
};
