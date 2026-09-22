(function () {
  "use strict";

  // Aponta para a API do GrowAI (ver pasta backend/), hospedada como um
  // SEGUNDO projeto na Vercel (projeto "growai-backend", Root Directory =
  // backend/, repo growai-tcc), com domínio HTTPS próprio.
  //
  // Era: em localhost/rede local, tentava um backend Express rodando na
  // porta 3000 DA MÁQUINA (http://<host>:3000/api) — só funcionava se você
  // tivesse esse servidor local rodando à parte, o que não é o fluxo real
  // de trabalho (edita o arquivo, dá refresh no Live Server). Sem esse
  // servidor local, toda a página parecia quebrada: nenhum dado carregava
  // e cada card/seção caía no estado de erro/vazio ("Não foi possível
  // conectar ao servidor"). Agora sempre usa o backend de produção, local
  // ou publicado — os mesmos dados reais em qualquer lugar.
  var API_BASE = "https://growai-backend.vercel.app/api";

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
    logout() {
      clearSession();
      window.location.href = "login.html";
    },
    getUser: getUser,
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

    // ---- reports & suggestions ----
    getWeeklyReports: () => request("/reports/weekly"),
    getSuggestions: () => request("/suggestions"),
    applySuggestion: (id) => request(`/suggestions/${id}/apply`, { method: "PATCH" }),

    // ---- settings ----
    getNotificationSettings: () => request("/settings/notifications"),
    updateNotificationSettings: (data) =>
      request("/settings/notifications", { method: "PATCH", body: JSON.stringify(data) }),
  };
})();
