// Prompts da IA. Ficam separados de services/ia.js para dar para ajustar o
// texto sem mexer nas chamadas HTTP dos provedores.
//
// Dois modos:
//   montarPromptFoto()   - analisa uma foto (sinais visuais)
//   montarPromptRotina() - analisa só os números da rotina contra a espécie e
//                          a finalidade, sem foto nenhuma
//
// Três regras que os dois carregam, por honestidade do TCC:
//  - a IA só vê o que mandamos. Não existe sensor de pH nem de luminosidade,
//    então ela não pode falar de nenhum dos dois;
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
- Nutriente: ${ou(c.nutri_s, "?")} s de dosagem por dia, às ${ou(c.nutri_hora, "?")}`;
}

function blocoLeitura(l) {
  const umidade =
    !l || l.humidity === null || l.humidity === undefined ? "sem leitura" : `${Math.round(Number(l.humidity))}%`;
  const temp =
    !l || l.temperature === null || l.temperature === undefined
      ? "sem leitura"
      : `${Number(l.temperature).toFixed(1)} °C`;
  return `## Leitura dos sensores
- Umidade do substrato: ${umidade}
- Temperatura do ar: ${temp}

Só existem esses dois sensores. NÃO há sensor de pH, de luminosidade, de
condutividade nem de nutrientes — não mencione nenhum deles.`;
}

function blocoLimites() {
  return `  - humidity_target: ${LIMITES.humidity_target[0]} a ${LIMITES.humidity_target[1]}
  - light_hours: ${LIMITES.light_hours[0]} a ${LIMITES.light_hours[1]}
  - vent_min_por_hora: ${LIMITES.vent_min_por_hora[0]} a ${LIMITES.vent_min_por_hora[1]}
  - temp_max: ${LIMITES.temp_max[0]} a ${LIMITES.temp_max[1]}
  - nutri_s: ${LIMITES.nutri_s[0]} a ${LIMITES.nutri_s[1]}`;
}

// ------------------------------------------------- modo foto (análise visual)
function montarPromptFoto({ estacao, leitura, config }) {
  return `Você é especialista em fisiologia vegetal e cultivo semi-hidropônico de plantas medicinais. Avalie a foto desta planta e responda em JSON.

${blocoPlanta(estacao)}

${blocoLeitura(leitura)}

${blocoConfig(config || {})}

## Sobre a foto
Foi tirada com o LED de cultivo (roxo) APAGADO e flash branco da câmera. As
cores são reais: pode confiar em tons de verde, amarelo e marrom.

## O que avaliar
Apenas SINAIS VISUAIS: cor das folhas, murcha, manchas, bordas secas, pragas
visíveis, porte, vigor e — se a finalidade pedir — presença e quantidade de flores.

Regras:
1. Não invente medição que não recebeu.
2. Se a foto estiver escura, embaçada, fora de foco ou sem planta visível, use
   health_status "atencao", diga isso em analysis_text e devolva suggestion: null.
   NÃO descreva uma planta que você não consegue ver.
3. Não repita os números dos sensores em analysis_text — o app já os mostra ao lado.

## Resposta
- health_status: "saudavel" se não houver sinal visual preocupante; "atencao" se houver.
- analysis_text: até 200 caracteres, em português do Brasil, falando direto com
  quem cultiva. Diga o que você viu e, se for o caso, o que fazer.
- suggestion: quase sempre null. Só proponha algo se um sinal VISUAL indicar que
  vale mudar o ambiente, e só UM ajuste por vez:
  - message: a justificativa, em uma frase, dizendo o que você viu.
  - growth_pct e health_pct: ganho esperado, de 0 a 30. Seja conservador.
  - config: só os campos que mudam, dentro destes limites:
${blocoLimites()}

Responda SOMENTE o JSON, sem texto antes ou depois.`;
}

// --------------------------------------- modo rotina (sem foto, só os números)
function montarPromptRotina({ estacao, leitura, config }) {
  return `Você é especialista em fisiologia vegetal e cultivo semi-hidropônico de plantas medicinais. O usuário acabou de configurar a rotina de cultivo abaixo. Avalie se ela faz sentido para esta espécie e esta finalidade, e responda em JSON.

Você NÃO recebeu foto nesta avaliação. Julgue apenas os números da rotina.

${blocoPlanta(estacao)}

${blocoConfig(config || {})}

${blocoLeitura(leitura)}

## O que avaliar
A rotina serve para esta espécie, considerando a finalidade declarada?

Pense em:
- **Fotoperíodo** — as horas de luz batem com o que a espécie precisa para o
  estágio que interessa? Camomila e outras que se usam pela flor precisam de dia
  longo para florescer; folhosas como hortelã rendem mais folha com dia mais curto.
- **Faixa de umidade** — está encharcando ou secando demais para esta espécie?
  Aromáticas mediterrâneas não gostam de substrato sempre úmido.
- **Temperatura máxima** antes de ligar a ventilação — está alta demais para a
  espécie aguentar sem estresse?
- **Ventilação** — pouca favorece fungo em ambiente úmido; muita resseca.
- **Nutriente** — a dose diária é compatível com o porte da planta?

Regras:
1. Não invente medição que não recebeu, e não cite pH nem luminosidade.
2. Se a rotina está adequada, diga isso e devolva suggestion: null. Não invente
   problema para parecer útil.
3. Se a espécie declarada não for uma planta reconhecível, ou a finalidade não
   fizer sentido para ela, diga isso em analysis_text com health_status
   "atencao" e devolva suggestion: null — não adivinhe uma rotina.
4. Aponte **o problema mais importante**, não todos. Um ajuste por vez.

## Resposta
- health_status: "saudavel" se a rotina está adequada; "atencao" se há algo a corrigir.
- analysis_text: até 200 caracteres, em português do Brasil. Se houver problema,
  diga QUAL parâmetro está errado e por quê, ligando à espécie ou à finalidade.
  Ex.: "12 h de luz é pouco para a camomila florescer; ela precisa de dia longo."
- suggestion: null se a rotina está boa. Se não está:
  - message: a justificativa, em uma frase, citando a espécie ou a finalidade.
  - growth_pct e health_pct: ganho esperado, de 0 a 30. Seja conservador.
  - config: só os campos que precisam mudar, dentro destes limites:
${blocoLimites()}

Responda SOMENTE o JSON, sem texto antes ou depois.`;
}

module.exports = {
  montarPromptFoto,
  montarPromptRotina,
  // nome antigo, mantido para não quebrar quem já importava
  montarPrompt: montarPromptFoto,
  ESQUEMA_RESPOSTA,
};
