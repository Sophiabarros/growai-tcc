// Temperatura atual de São Paulo, da internet: a MEDIÇÃO do aeroporto de
// Congonhas (METAR), com modelos de previsão como reserva. Grátis, sem chave.
//
// Usada só quando o sensor da placa (DS18B20) não tem leitura: o app mostra
// esta temperatura no lugar, marcada como "São Paulo (internet)", e o aviso de
// sensor com defeito continua aparecendo. É a temperatura do ar da cidade,
// não a medida na horta — serve de referência, não de medição.
//
// Cache de 15 min: o Open-Meteo atualiza a cada 15 min, e o painel do app
// pede a leitura a cada poucos segundos.

const CACHE_MS = 15 * 60 * 1000;

/* Três fontes, tentadas em ordem. O Open-Meteo sozinho falhava no Render:
   ele limita IPs de nuvem compartilhados, e no servidor a temperatura voltava
   vazia (no computador local funcionava). Cada fonte devolve °C ou lança. */
const UA = "GrowAI-TCC/1.0 (+https://growai-xi.vercel.app)";
const FONTES = [
  {
    /* MEDIÇÃO real, não previsão: o boletim METAR das estações dos
       aeroportos, atualizado a cada hora. Congonhas fica dentro da cidade;
       Campo de Marte é a reserva. As fontes de baixo são modelos numéricos e
       erravam 1-2 °C (em 15/10 21h: Open-Meteo 18,7 °C, Congonhas mediu 20 °C,
       o mesmo do app de clima do celular). Boletim com mais de 2 h é ignorado. */
    nome: "METAR Congonhas",
    url: "https://aviationweather.gov/api/data/metar?ids=SBSP,SBMT&format=json",
    ler: (lista) => {
      const recente = (m) => m && m.temp != null && Date.now() - new Date(m.reportTime).getTime() < 2 * 3600 * 1000;
      const sbsp = lista.find((m) => m.icaoId === "SBSP");
      const sbmt = lista.find((m) => m.icaoId === "SBMT");
      // Com a hora do boletim: o app mostra "SP · 21h" e dá para ver que muda.
      if (recente(sbsp)) return { temp: sbsp.temp, em: sbsp.reportTime };
      if (recente(sbmt)) return { temp: sbmt.temp, em: sbmt.reportTime };
      throw new Error("sem boletim recente");
    },
  },
  {
    nome: "Open-Meteo",
    url: "https://api.open-meteo.com/v1/forecast?latitude=-23.55&longitude=-46.63&current=temperature_2m&timezone=America%2FSao_Paulo",
    ler: (j) => j.current.temperature_2m,
  },
  {
    // MET Norway exige um User-Agent que identifique o app.
    nome: "MET Norway",
    url: "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=-23.55&lon=-46.63",
    ler: (j) => j.properties.timeseries[0].data.instant.details.air_temperature,
  },
  {
    nome: "wttr.in",
    url: "https://wttr.in/Sao+Paulo?format=j1",
    ler: (j) => j.current_condition[0].temp_C,
  },
];

let cache = null; // { temperatura, em, fonte }
let buscando = null;
let ultimaFalha = null; // texto do último erro, para GET /api/health/clima

async function buscar() {
  const falhas = [];
  for (const f of FONTES) {
    try {
      const res = await fetch(f.url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // ler() devolve °C, ou { temp, em } quando a fonte diz a hora da medição.
      const v = f.ler(await res.json());
      const t = Number(v && typeof v === "object" ? v.temp : v);
      if (!Number.isFinite(t)) throw new Error("sem temperatura na resposta");
      const medidaEm = v && typeof v === "object" && v.em ? new Date(v.em).getTime() : Date.now();
      cache = { temperatura: Math.round(t * 10) / 10, em: Date.now(), medidaEm, fonte: f.nome };
      if (falhas.length) console.warn(`[temperatura] ${f.nome} respondeu depois de: ${falhas.join(" | ")}`);
      return cache;
    } catch (err) {
      falhas.push(`${f.nome}: ${err.message}`);
    }
  }
  ultimaFalha = falhas.join(" | ");
  throw new Error(ultimaFalha);
}

// Estado para diagnóstico (GET /api/health/clima). Nada sensível aqui.
async function diagnostico() {
  const r = await temperaturaSaoPaulo();
  return { temperatura: r ? r.temperatura : null, fonte: r ? r.fonte : null,
           atualizada_em: r ? new Date(r.em).toISOString() : null,
           medida_em: r && r.medidaEm ? new Date(r.medidaEm).toISOString() : null, ultima_falha: ultimaFalha };
}

/* Devolve { temperatura, em } ou null. Nunca lança: sem internet, a tela só
   fica com "—", como antes. Uma busca por vez, mesmo com vários pedidos. */
async function temperaturaSaoPaulo() {
  if (cache && Date.now() - cache.em < CACHE_MS) return cache;
  if (!buscando) {
    buscando = buscar()
      .catch((err) => {
        console.warn("[temperatura] São Paulo indisponível:", err.message);
        return cache; // o valor antigo é melhor que nada
      })
      .finally(() => {
        buscando = null;
      });
  }
  return buscando;
}

/* Versão que não espera: devolve o que já está em cache (até 1 h de idade) e,
   se estiver velho, dispara a atualização para a próxima vez. É a usada na
   telemetria, que responde à placa e não pode esperar a internet. */
function temperaturaSaoPauloJa() {
  if (!cache || Date.now() - cache.em >= CACHE_MS) temperaturaSaoPaulo();
  return cache && Date.now() - cache.em < 60 * 60 * 1000 ? cache : null;
}

/* Preenche a temperatura de uma leitura sem sensor. Marca a origem para o app
   escrever "São Paulo (internet)" e manter o aviso do sensor. */
function completarTemperatura(leitura, externa) {
  if (!leitura || (leitura.temperature !== null && leitura.temperature !== undefined)) return leitura;
  if (!externa) return leitura;
  return {
    ...leitura,
    temperature: externa.temperatura,
    temperatura_fonte: "sao_paulo",
    temperatura_medida_em: new Date(externa.medidaEm || externa.em).toISOString(),
  };
}

module.exports = { temperaturaSaoPaulo, temperaturaSaoPauloJa, completarTemperatura, diagnostico };
