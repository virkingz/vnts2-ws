import { Vnts2Room } from "./room.js";
import { PROJECT_URL } from "./protocol.js";

export { Vnts2Room };

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const options = env.LOCATION_HINT ? { locationHint: env.LOCATION_HINT } : undefined;
      const stub = env.VNTS2_ROOM.get(env.VNTS2_ROOM.idFromName("global"), options);

      if (url.pathname === "/peer" && env.SERVER_TOKEN) {
        return await stub.fetch(request);
      }

      if (url.pathname.startsWith("/peer/")) {
        return await stub.fetch(request);
      }

      if (url.pathname === "/" && request.headers.get("Upgrade") === "websocket") {
        return await stub.fetch(request);
      }

      if (url.pathname === "/test" || url.pathname === "/room") {
        return await stub.fetch(request);
      }

      // /logout 为公共登出入口，始终路由到 Durable Object，
      // 由其统一下发各认证 Cookie 的过期指令。
      if (url.pathname === "/logout") {
        return await stub.fetch(request);
      }

      // 未配置 LOG_PASSWORD 时 /log 和 /log/clear 不路由到 Durable Object，直接跳转项目地址
      if (env.LOG_PASSWORD && (url.pathname === "/log" || url.pathname === "/log/clear")) {
        return await stub.fetch(request);
      }

      // 302 跳转到项目地址
      return Response.redirect(PROJECT_URL, 302);
    } catch (error) {
      console.error("[vnts2-cf] Worker 请求处理失败", error);
      return Response.json({ ok: false, error: "服务暂时不可用" }, { status: 503 });
    }
  }
};
