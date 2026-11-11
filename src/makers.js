// src/makers.js —— EdgeOne Makers 入口适配
//
// Makers 的 [[default]].js 会以几种可能的形态被调用：
//   onRequest(context)                   context = { request, env, params, ... }
//   onRequest(request, env, ctx)         标准 fetch 风格
//   onRequest(request)                   只有 request
// 三种都得认。少认一种的后果不是报错，而是 env 静默变成 process.env ——
// 环境变量明明配了却不生效，排查起来非常费劲（限流最初就踩了这个坑）。
import app from './app.js';

const handler = async (context, envArg, ctxArg) => {
  const request = context?.request ?? context;
  const env = context?.env ?? envArg ?? ctxArg?.env ?? process.env;
  return app.fetch(request, env, ctxArg ?? context);
};

handler.fetch = handler;
handler.onRequest = handler;

export default handler;
export { handler as onRequest, handler as fetch };
