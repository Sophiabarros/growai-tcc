(function () {
  "use strict";

  // Aponta para a API do GrowAI (ver pasta backend/). Em localhost/rede
  // local usa o backend/ Express na porta 3000 (mesmo host da página, não
  // "localhost" fixo, pra funcionar também de outro dispositivo na rede,
  // ex.: celular abrindo http://<ip-do-pc>:5500/...). Fora disso (site
  // publicado na Vercel) usa o backend, que é um SEGUNDO projeto na Vercel
  // (Root Directory = backend/) com domínio HTTPS próprio.
  //
  // TODO: depois de criar o projeto "backend" na Vercel, troque o domínio
  // abaixo pelo que a Vercel gerar (ex.: https://growai-backend.vercel.app/api).
  var PRODUCTION_API_BASE = "https://SEU-BACKEND.vercel.app/api";

  function isLocalHost(hostname) {
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname)
    );
  }
  var API_BASE = isLocalHost(window.location.hostname)
    ? "http://" + window.location.hostname + ":3000/api"
    : PRODUCTION_API_BASE;

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

  // Applies the logged-in user's avatar (if any) to the shared header
  // avatar already present on every app-*.html page, so a photo changed
  // on the Configurações page shows up elsewhere too without each page
  // needing its own wiring for this.
  function applyCachedAvatar() {
    var user = getUser();
    if (!user || !user.avatar_url) return;
    var url = API_BASE.replace(/\/api$/, "") + user.avatar_url;
    document.querySelectorAll(".app-header__avatar img").forEach(function (img) {
      img.src = url;
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyCachedAvatar);
  } else {
    applyCachedAvatar();
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
      throw new Error("Não foi possível conectar ao servidor. Tente novamente.");
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
      throw new Error((body && body.error) || "Erro na requisição (" + res.status + ")");
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
    async updateProfile(formData) {
      var user = await request("/auth/me", { method: "PUT", body: formData });
      updateCachedUser(user);
      return user;
    },
    avatarUrl(user) {
      if (!user || !user.avatar_url) return null;
      return API_BASE.replace(/\/api$/, "") + user.avatar_url;
    },

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
