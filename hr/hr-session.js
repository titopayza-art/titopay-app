"use strict";

(() => {
  const HR_API_BASE = "https://api.titopay.co.za/api/v1/hr";
  const ACCESS_TOKEN_KEY = "hr_token";
  const REFRESH_TOKEN_KEY = "hr_refresh_token";
  const USER_KEY = "hr_user";
  const nativeFetch = window.fetch.bind(window);
  let refreshPromise = null;

  function requestUrl(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  function isHrApiRequest(url) {
    return url === HR_API_BASE || url.startsWith(`${HR_API_BASE}/`);
  }

  function isAuthRequest(url) {
    return url.includes("/auth/login") || url.includes("/auth/refresh") || url.includes("/auth/reset");
  }

  function saveSession(payload = {}) {
    const accessToken = payload.accessToken || payload.token;
    if (accessToken) localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    if (payload.refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, payload.refreshToken);
    if (payload.user) localStorage.setItem(USER_KEY, JSON.stringify(payload.user));
    return accessToken || "";
  }

  function clearSession() {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem("hr_mode");
  }

  async function rememberLoginSession(response, url) {
    if (!response.ok || !url.includes("/auth/login")) return;
    try {
      saveSession(await response.clone().json());
    } catch (_error) {
      // The application will surface an invalid login payload.
    }
  }

  async function refreshAccessToken() {
    if (refreshPromise) return refreshPromise;
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    if (!refreshToken) return "";

    refreshPromise = nativeFetch(`${HR_API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken })
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "HR session expired");
        return saveSession(payload);
      })
      .catch(() => {
        clearSession();
        return "";
      })
      .finally(() => {
        refreshPromise = null;
      });

    return refreshPromise;
  }

  function retryWithToken(input, init, accessToken) {
    const headers = new Headers(
      (init && init.headers) ||
      (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined)
    );
    headers.set("Authorization", `Bearer ${accessToken}`);

    if (typeof Request !== "undefined" && input instanceof Request) {
      return nativeFetch(new Request(input, { ...(init || {}), headers }));
    }
    return nativeFetch(input, { ...(init || {}), headers });
  }

  function requestWithCurrentToken(input, init) {
    const url = requestUrl(input);
    const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
    if (!accessToken || !isHrApiRequest(url) || isAuthRequest(url)) {
      return nativeFetch(input, init);
    }
    return retryWithToken(input, init, accessToken);
  }

  window.fetch = async (input, init = {}) => {
    const url = requestUrl(input);
    // The compiled portal previously captured the access token once per
    // component render. Always replace that stale header with the latest
    // token before the first request, including after a token rotation.
    const response = await requestWithCurrentToken(input, init);

    if (!isHrApiRequest(url)) return response;
    await rememberLoginSession(response, url);

    if (url.includes("/auth/logout")) {
      clearSession();
      return response;
    }
    if (response.status !== 401 || isAuthRequest(url)) return response;

    const accessToken = await refreshAccessToken();
    if (!accessToken) return response;
    return retryWithToken(input, init, accessToken);
  };

  // Sessions created by the older HR bundle retained only the short-lived
  // access token. Force one clean sign-in instead of leaving the dashboard in
  // a false signed-in state that cannot refresh authenticated API requests.
  if (
    localStorage.getItem(ACCESS_TOKEN_KEY)
    && localStorage.getItem(USER_KEY)
    && !localStorage.getItem(REFRESH_TOKEN_KEY)
  ) {
    clearSession();
    if (location.pathname !== "/login") location.replace("/login");
  }

  // Remove a refresh token left behind by the older bundle's local inactivity
  // logout, which cleared the user and access token but not the refresh token.
  if (
    !localStorage.getItem(ACCESS_TOKEN_KEY)
    && !localStorage.getItem(USER_KEY)
    && localStorage.getItem(REFRESH_TOKEN_KEY)
  ) {
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  }
})();
