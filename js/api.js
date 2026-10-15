(function () {
  "use strict";

  // Aponta para a API do GrowAI (ver pasta backend/), hospedada no Render
  // (serviço "growai-backend", ver render.yaml), com domínio HTTPS próprio.
  // O site continua na Vercel. ÚNICO lugar com o endereço do backend.
  //
  // Era: em localhost/rede local, tentava um backend Express rodando na
  // porta 3000 DA MÁQUINA (http://<host>:3000/api) — só funcionava se você
  // tivesse esse servidor local rodando à parte, o que não é o fluxo real
  // de trabalho (edita o arquivo, dá refresh no Live Server). Sem esse
  // servidor local, toda a página parecia quebrada: nenhum dado carregava
  // e cada card/seção caía no estado de erro/vazio ("Não foi possível
  // conectar ao servidor"). Agora sempre usa o backend de produção, local
  // ou publicado — os mesmos dados reais em qualquer lugar.
  var API_PRODUCAO = "https://growai-backend-ssca.onrender.com/api";

  /* ...COM UMA SAÍDA para desenvolvimento.
     O Live Server serve só as PÁGINAS; os dados continuam vindo do endereço
     acima. Então, ao testar uma mudança de backend, o app segue falando com
     produção e a mudança parece não funcionar — a correção está na sua
     máquina, mas quem responde é a Vercel.

     Para apontar para o backend local, no console do navegador:
       localStorage.setItem("growai_api_local", "1");   location.reload();
     E para voltar:
       localStorage.removeItem("growai_api_local");     location.reload();

     Pode-se passar uma URL completa em vez de "1" (útil para testar pelo
     celular na mesma rede): localStorage.setItem("growai_api_local",
     "http://192.168.0.10:3000/api").

     Quem usa o site publicado nunca tem essa chave, então nada muda para o
     usuário final. */
  var API_BASE = API_PRODUCAO;
  try {
    var apiLocal = localStorage.getItem("growai_api_local");
    if (apiLocal) {
      API_BASE =
        apiLocal === "1" || apiLocal === "true"
          ? "http://localhost:3000/api"
          : String(apiLocal).replace(/\/+$/, "");
      console.warn(
        "[GrowAI] usando API LOCAL: " + API_BASE +
          "\nPara voltar a produção: localStorage.removeItem(\"growai_api_local\"); location.reload();"
      );
    }
  } catch (e) {
    /* localStorage bloqueado (modo anônimo, cookies desligados): segue em produção */
  }

  // WebSocket do mesmo backend: https://host/api -> wss://host/ws
  var WS_URL = API_BASE.replace(/^http/, "ws").replace(/\/api$/, "/ws");

  var TOKEN_KEY = "growai_token";
  var USER_KEY = "growai_user";

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function getUser() {
    var raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function setSession(user, token) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  function updateCachedUser(user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  // A foto de perfil é guardada no banco como data URL (data:image/jpeg;base64,...)
  // porque o filesystem da Vercel é somente-leitura; caminhos antigos ("/uploads/...")
  // ainda são resolvidos contra o host da API.
  function resolveAvatarUrl(user) {
    if (!user || !user.avatar_url) return null;
    var value = user.avatar_url;
    if (/^(data:|https?:)/i.test(value)) return value;
    return API_BASE.replace(/\/api$/, "") + value;
  }

  // Applies the logged-in user's avatar (if any) to the shared header
  // avatar already present on every app-*.html page, so a photo changed
  // on the Configurações page shows up elsewhere too without each page
  // needing its own wiring for this.
  function applyCachedAvatar() {
    var url = resolveAvatarUrl(getUser());
    if (!url) return;
    document.querySelectorAll(".app-header__avatar img").forEach(function (img) {
      img.src = url;
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyCachedAvatar);
  } else {
    applyCachedAvatar();
  }

  // Sincroniza o perfil do usuário com o servidor (puxando avatar e outros
  // dados atualizados) e atualiza a exibição. Chamado ao carregar as páginas
  // do app (app-home, app-camera, etc) pra garantir que mudanças feitas em
  // outro dispositivo (ex: foto de perfil) apareçam na página atual.
  async function syncProfile() {
    if (!isAuthenticated()) return;
    try {
      await request("/auth/me").then(function (user) {
        updateCachedUser(user);
        applyCachedAvatar();
      });
    } catch (e) {
      // Se a sincronização falhar (rede, 401), continua com o cache.
      // Não joga erro pra não quebrar o carregamento da página.
    }
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  function isAuthenticated() {
    return !!getToken();
  }

  async function request(path, options) {
    options = options || {};
    var isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;

    var headers = Object.assign(
      isFormData ? {} : { "Content-Type": "application/json" },
      getToken() ? { Authorization: "Bearer " + getToken() } : {},
      options.headers || {}
    );

    var res;
    try {
      res = await fetch(API_BASE + path, Object.assign({}, options, { headers: headers }));
    } catch (networkErr) {
      // status 0 == request never reached the server (offline, DNS, CORS) —
      // callers can use this to tell "no connection" apart from "server
      // responded with an error" without parsing the message text.
      var offlineErr = new Error("Não foi possível conectar ao servidor. Tente novamente.");
      offlineErr.status = 0;
      throw offlineErr;
    }

    if (res.status === 401 && path !== "/auth/login") {
      clearSession();
      window.location.href = "login.html";
      return;
    }

    var body = null;
    try {
      body = res.status === 204 ? null : await res.json();
    } catch {
      body = null;
    }

    if (!res.ok) {
      var httpErr = new Error((body && body.error) || "Erro na requisição (" + res.status + ")");
      httpErr.status = res.status;
      throw httpErr;
    }
    return body;
  }

  window.GrowAI = {
    // ---- auth ----
    async login(email, password) {
      var data = await request("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: email, password: password }),
      });
      setSession(data.user, data.token);
      return data;
    },
    async register(name, email, password) {
      var data = await request("/auth/register", {
        method: "POST",
        body: JSON.stringify({ name: name, email: email, password: password }),
      });
      setSession(data.user, data.token);
      return data;
    },
    // Recuperação de senha (rotas públicas do backend). O e-mail traz um link
    // com token para redefinir-senha.html; o token expira e só vale uma vez.
    forgotPassword(email) {
      return request("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: email }),
      });
    },
    resetPassword(token, password) {
      return request("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token: token, password: password }),
      });
    },
    logout() {
      clearSession();
      window.location.href = "login.html";
    },
    getUser: getUser,
    // Endereco da API em uso agora (producao ou o override local). A tela
    // Conexao ESP32 mostra este valor para o usuario colar no portal da placa.
    apiBase: function () { return API_BASE; },
    wsUrl: function () { return WS_URL; },
    isAuthenticated: isAuthenticated,
    async getMe() {
      var user = await request("/auth/me");
      updateCachedUser(user);
      return user;
    },
    async syncProfile() {
      return syncProfile();
    },
    async updateProfile(formData) {
      var user = await request("/auth/me", { method: "PUT", body: formData });
      updateCachedUser(user);
      return user;
    },
    avatarUrl: resolveAvatarUrl,

    // ---- stations ----
    getStations: () => request("/stations"),
    createStation: (data) => request("/stations", { method: "POST", body: JSON.stringify(data) }),
    updateStation: (id, data) => request(`/stations/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    deleteStation: (id) => request(`/stations/${id}`, { method: "DELETE" }),
    getLatestReading: (id) => request(`/stations/${id}/readings/latest`),
    getLatestPhoto: (id) => request(`/stations/${id}/photos/latest`),

    // ---- controle manual das placas ----
    // Usado pelo painel "Controlar placa" (js/control-modal.js).
    // createCommand enfileira; com o app aberto a placa busca a cada 5 s e
    // confirma em ~1 s depois de executar.
    // Os limites de seguranca (50 s de bomba, 30 s de nutriente por dia) sao
    // do firmware: dur_s maior que isso e aceito e cortado pela placa.
    createCommand: (id, data) =>
      request(`/stations/${id}/commands`, { method: "POST", body: JSON.stringify(data) }),
    getCommands: (id) => request(`/stations/${id}/commands`),
    getDevices: (id) => request(`/stations/${id}/devices`),
    /* Cadastra uma placa e devolve a chave EM TEXTO PURO no campo `chave`.
       E a unica vez que ela existe fora da placa: o banco guarda so o sha256.
       Pedir de novo para o mesmo tipo substitui a anterior. */
    createDevice: (id, tipo, nome) =>
      request(`/stations/${id}/devices`, { method: "POST", body: JSON.stringify({ tipo: tipo, nome: nome }) }),
    deleteDevice: (id, deviceId) => request(`/stations/${id}/devices/${deviceId}`, { method: "DELETE" }),

    // ---- reports & suggestions ----
    getWeeklyReports: () => request("/reports/weekly"),
    // Um dia hora a hora (padrão: hoje). dia = "YYYY-MM-DD".
    getDailyReport: (stationId, dia) =>
      request("/reports/daily?station_id=" + encodeURIComponent(stationId) + (dia ? "&dia=" + encodeURIComponent(dia) : "")),
    getSuggestions: () => request("/suggestions"),
    applySuggestion: (id) => request(`/suggestions/${id}/apply`, { method: "PATCH" }),
    // Desfaz um ajuste que a IA aplicou sozinha: volta aos valores de antes.
    undoSuggestion: (id) => request(`/suggestions/${id}/undo`, { method: "PATCH" }),
    // Pede a IA para avaliar a rotina contra a especie e a finalidade da
    // estacao. Nao manda foto. Chamado depois de salvar a rotina.
    // forcar = true pula a carência de 2 min do backend: o modal só pede de
    // novo quando a rotina realmente mudou.
    evaluateRoutine: (id, forcar) =>
      request(`/stations/${id}/avaliar-rotina${forcar ? "?forcar=1" : ""}`, { method: "POST" }),

    // ---- settings ----
    getNotificationSettings: () => request("/settings/notifications"),
    updateNotificationSettings: (data) =>
      request("/settings/notifications", { method: "PATCH", body: JSON.stringify(data) }),

    /* ---- ao vivo ----
       GrowAI.aoVivo(function (msg) { ... }) recebe o que o backend avisa pelo
       WebSocket: { tipo: "telemetria", station_id, leitura, confirmados } a
       cada fala da placa principal e { tipo: "foto", station_id } quando uma
       foto termina de ser analisada. Devolve a função que cancela.
       Uma conexão só por aba, reaberta sozinha se cair. Enquanto ela está
       aberta, o backend pede à placa para falar a cada 5 s em vez de 15. */
    aoVivo: function (handler) {
      ouvintes.push(handler);
      conectarAoVivo();
      return function () {
        ouvintes = ouvintes.filter(function (h) { return h !== handler; });
      };
    },

    /* Câmera ao vivo de uma estação (cam-2.0.0 em diante).
         var parar = GrowAI.assistirCamera(stationId, {
           onQuadro: function (blobJpeg) { ... },     // ~2 por segundo
           onStatus: function (msg) { msg.cam_online }
         });
         parar();   // ao fechar o visor
       O pedido é renovado a cada 15 s; sem renovação o backend e a câmera
       param sozinhos em ~30 s. Uma câmera por vez por aba. */
    assistirCamera: function (stationId, h) {
      h = h || {};
      if (pararAssistir) pararAssistir();
      var ativo = true;
      var cancelar = GrowAI.aoVivo(function (msg) {
        if (msg.tipo === "ao_vivo_status" && Number(msg.station_id) === Number(stationId) && h.onStatus) h.onStatus(msg);
      });
      assistindo = stationId;
      quadroOuvinte = h.onQuadro || null;
      pedirAoVivo();
      var renova = setInterval(pedirAoVivo, 15000);
      pararAssistir = function () {
        if (!ativo) return;
        ativo = false;
        clearInterval(renova);
        cancelar();
        enviarWs({ tipo: "ao_vivo", station_id: stationId, ligar: false });
        assistindo = null;
        quadroOuvinte = null;
        pararAssistir = null;
      };
      return pararAssistir;
    },
  };

  var ouvintes = [];
  var ws = null;
  var esperaReconexao = 1000;
  var assistindo = null;      // estação cuja câmera esta aba está vendo
  var quadroOuvinte = null;
  var pararAssistir = null;

  function enviarWs(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function pedirAoVivo() {
    if (assistindo != null) enviarWs({ tipo: "ao_vivo", station_id: assistindo, ligar: true });
  }

  function conectarAoVivo() {
    if (ws || !getToken() || typeof WebSocket === "undefined") return;
    try {
      ws = new WebSocket(WS_URL + "?token=" + encodeURIComponent(getToken()));
    } catch (e) {
      ws = null;
      return;
    }
    ws.binaryType = "blob";
    ws.onopen = function () {
      esperaReconexao = 1000;
      pedirAoVivo(); // reconectou no meio do ao vivo: pede de novo
    };
    ws.onmessage = function (ev) {
      // Binário = quadro JPEG da câmera ao vivo.
      if (typeof ev.data !== "string") {
        if (quadroOuvinte) quadroOuvinte(ev.data);
        return;
      }
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      ouvintes.slice().forEach(function (h) {
        try { h(msg); } catch (e) { console.error("[GrowAI] ouvinte ao vivo falhou:", e); }
      });
    };
    ws.onclose = function () {
      ws = null;
      if (!ouvintes.length || !getToken()) return;
      // 1 s, 2 s, 4 s ... até 30 s: o Render pode estar reiniciando num deploy.
      setTimeout(conectarAoVivo, esperaReconexao);
      esperaReconexao = Math.min(esperaReconexao * 2, 30000);
    };
  }
})();
