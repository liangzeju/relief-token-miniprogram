(function () {
  "use strict";
  const isAdmin = /\/admin(?:\/|$)/.test(location.pathname);
  const baseUrl = (window.RELIEF_API_BASE || "").replace(/\/$/, "");
  const lists = ["donations", "tasks", "contracts", "traces", "chainTransactions", "deliveries", "settlements", "redemptions", "disasterUpdates", "marketplace", "marketOrders", "allocationPlans", "permissions", "processVisuals"];
  let current = normalize({});
  let generation = 0;

  function normalize(payload) {
    const data = Object.assign({}, payload);
    data.dashboard = Object.assign({ depositedMon: 0, availableMon: 0, escrowMon: 0, participantCount: 0, poolTargetMon: 0, chainEvents: 0 }, payload.dashboard);
    data.network = Object.assign({ name: "monad-testnet", chainId: 10143, mode: "demo" }, payload.network);
    data.user = payload.user || {};
    lists.forEach(function (key) { data[key] = Array.isArray(payload[key]) ? payload[key] : []; });
    return data;
  }

  function url(path) { return baseUrl + path; }

  async function request(path, options) {
    if (location.protocol === "file:") throw new Error("请启动后端，并从 http://localhost:8787/mobile/ 访问前台");
    options = options || {};
    const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
    if (isAdmin && !path.startsWith("/v1/public/")) headers["X-Relief-Actor"] = "admin";
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, 10000);
    try {
      const response = await fetch(url(path), Object.assign({}, options, { credentials: "same-origin", headers: headers, signal: controller.signal, cache: "no-store" }));
      const payload = await response.json();
      if (!response.ok) {
        const detail = payload.error || {};
        const error = new Error(detail.message || "服务请求失败（" + response.status + "）");
        error.status = response.status;
        error.code = detail.code;
        throw error;
      }
      return payload;
    } finally { clearTimeout(timeout); }
  }

  async function liveData() {
    const ticket = generation;
    const response = await request(isAdmin ? "/v1/overview" : "/v1/public/overview");
    if (ticket !== generation) throw Object.assign(new Error("登录状态已变化"), { code: "AUTH_CHANGED" });
    if (!response.data || !response.data.dashboard) throw new Error("后端概览数据不完整");
    current = normalize(response.data);
    return current;
  }

  window.ReliefApi = {
    url: url,
    data: function () { return normalize(current); },
    clearData: function () { generation++; current = normalize({}); return normalize(current); },
    liveData: liveData,
    request: request,
    liveProcess: async function () { return (await request("/v1/demo/process")).data; },
    detail: async function (type, id) { return (await request("/v1/details/" + encodeURIComponent(type) + "/" + encodeURIComponent(id))).data; },
    publicTrace: async function (ref) { return (await request("/v1/public/trace/" + encodeURIComponent(ref))).data; }
  };
}());
