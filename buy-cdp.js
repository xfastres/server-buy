/**
 * 通过 CDP 连接「你已手动打开的 Chrome」进行抢购，提交页购买按钮会正常显示。
 *
 * 使用步骤：
 * 1. 关闭所有 Chrome 窗口后，用以下命令启动 Chrome（保留此窗口不要关）：
 *    Windows: "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
 *    或: chrome.exe --remote-debugging-port=9222
 * 2. 在该 Chrome 里打开活动页并登录（或先登录腾讯云再打开活动页）
 * 3. 在本目录执行: node buy-cdp.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ACTIVITY_URL = 'https://cloud.tencent.com/act/pro/spring2026';
const CDP_URL = 'http://127.0.0.1:9222';
const LOG_FILE = path.join(__dirname, 'buy.log');
const ERR_FILE = path.join(__dirname, 'buy.err.log');
const PREV_LOG_FILE = path.join(__dirname, 'buy.prev.log');
const ERR_PREV_LOG_FILE = path.join(__dirname, 'buy.err.prev.log');

// 思路：
// 1. 每次启动把旧日志轮转到 *.prev.log 再清空，buy.log 只含本次运行，
//    新旧混排会干扰排查
// 2. 劫持 console：所有输出自动带毫秒级时间戳并落盘（错误另写 buy.err.log），
//    进程被强杀时日志已写入，能定位失败发生在哪一步
const realLog = console.log.bind(console);
const realError = console.error.bind(console);

const formatLogArgs = (args) => args.map((item) => {
  if (item instanceof Error) return item.stack || item.message;
  if (typeof item === 'object' && item !== null) {
    try { return JSON.stringify(item); } catch (_) { return String(item); }
  }
  return String(item);
}).join(' ');

const timestamp = () => {
  const now = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
};

const writeLogLine = (level, args, output) => {
  const line = `[${timestamp()}] [${level}] ${formatLogArgs(args)}`;
  output(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
    if (level === 'ERROR') fs.appendFileSync(ERR_FILE, line + '\n', 'utf8');
  } catch (e) {
    realError(`[日志] 写入日志文件失败: ${e.message}`);
  }
};

const rotateLog = (file, prevFile) => {
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, prevFile);
    fs.writeFileSync(file, '', 'utf8');
  } catch (e) {
    realError(`[日志] 轮转 ${path.basename(file)} 失败（不阻断）: ${e.message}`);
  }
};
rotateLog(LOG_FILE, PREV_LOG_FILE);
rotateLog(ERR_FILE, ERR_PREV_LOG_FILE);

console.log = (...args) => writeLogLine('INFO', args, realLog);
console.error = (...args) => writeLogLine('ERROR', args, realError);

async function checkPort9222() {
  return new Promise((resolve) => {
    const net = require('net');
    const s = net.createConnection(9222, '127.0.0.1', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(500, () => { s.destroy(); resolve(false); });
  });
}

const SECKILL_API = 'https://act-api.cloud.tencent.com/dianshi/query-seckill-by-date';
const ACTIVITY_ID = 166111704417621;
const TARGET_SKU = '4核4G3M';

// 思路：
// 1. 该接口对匿名请求放行，不带 Cookie 可绕过 CSRF 校验（已实测 200）
// 2. 只取带 available 字段的条目（同名商品的其他分组无此字段）
// 3. 网络异常返回 { error }，不抛出，避免中断主抢购流程
async function queryStock() {
  const startedAt = Date.now();
  try {
    const resp = await fetch(SECKILL_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': 'https://cloud.tencent.com',
        'Referer': 'https://cloud.tencent.com/',
      },
      body: JSON.stringify({
        activity_id: ACTIVITY_ID, preview: 0,
        seckill_type: 'block', goods_type: 'goods', days: 2,
      }),
    });
    // 408/432 限频：打 rateLimited 标记，监控循环据此长退避，
    // 不再以固定 2 秒频率硬撞（15:00 场库存查询也被 432 拦过）
    if (resp.status === 408 || resp.status === 432) {
      return { error: 'HTTP ' + resp.status, rateLimited: true, elapsed: Date.now() - startedAt };
    }
    if (!resp.ok) return { error: 'HTTP ' + resp.status, elapsed: Date.now() - startedAt };
    return { ...findTargetStock(await resp.json()), elapsed: Date.now() - startedAt };
  } catch (e) {
    return { error: e.message || String(e), elapsed: Date.now() - startedAt };
  }
}

// 从接口响应中定位目标商品的当日库存状态
// 结构：flashResult[日期] -> 分组[] -> sales[] -> 商品条目
// 思路：available/process 字段并非每天都有（11-05 实测缺失），字段缺时
// 返回 available:null 而非当「未找到」，保证监控对商品存在性判断正确
function findTargetStock(json) {
  const flash = (json && json.data && json.data.flashResult) || {};
  for (const day of Object.keys(flash).sort()) {
    for (const group of (flash[day] || [])) {
      for (const item of (group.sales || [])) {
        const sku = ((item.seckill_act_extra || {}).skuList || []).join(' ');
        if (sku.includes(TARGET_SKU)) {
          const available = typeof item.available === 'number' ? item.available : null;
          return { day, available, process: item.process ?? null, hasStockFields: available !== null };
        }
      }
    }
  }
  return { error: '未找到目标商品' };
}

// 是否处于开抢关键窗口（T-5s ~ T+15s）。
// 思路：10:00 场实测库存查询与 do-goods 共用同一 IP 的限频配额，
// 开抢瞬间每 2 秒一次的库存查询会挤占下单请求额度，是 408 的成因之一。
// 关键窗口内暂停轮询，把配额全部留给下单；窗口外恢复监控。
const inCriticalWindow = () => {
  const nowTs = Date.now();
  for (const hour of [10, 15]) {
    const target = new Date();
    target.setHours(hour, 0, 0, 0);
    const delta = nowTs - target.getTime();
    if (delta >= -5000 && delta <= 15000) return true;
  }
  return false;
};

// 每 2 秒轮询库存接口，仅在状态变化时打印；返回 stop() 供成功后停止
function startStockMonitor() {
  let stopped = false;
  let lastKey = '';
  console.log('[库存] 接口监控已启动（每2秒查询，状态变化时打印）');
  (async () => {
    while (!stopped) {
      // 关键窗口让路：不查库存，避免和下单请求抢同一份限频配额
      if (inCriticalWindow()) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      const stock = await queryStock();
      const key = stock.error
        ? 'err|' + stock.error
        : `${stock.day}|${stock.available}|${stock.process}`;
      if (key !== lastKey) {
        lastKey = key;
        if (stock.error) {
          console.log('[库存] 查询失败:', stock.error, `(${stock.elapsed}ms)`);
        } else if (!stock.hasStockFields) {
          console.log(`[库存] ${stock.day} 轻量${TARGET_SKU} 在排期中（接口未返回库存字段），耗时${stock.elapsed}ms`);
        } else {
          const status = stock.available === 1 ? '有货!!!' : '售罄';
          console.log(`[库存] ${stock.day} 轻量${TARGET_SKU} available=${stock.available}(${status}) process=${stock.process} 耗时${stock.elapsed}ms`);
        }
      }
      // 限频退避：408/432 后静默 15 秒，避免库存查询挤占抢购请求配额
      await new Promise((r) => setTimeout(r, stock.rateLimited ? 15000 : 2000));
    }
  })();
  return { stop() { stopped = true; } };
}

(async () => {
  console.log('[步骤1] 开始执行（CDP 模式：连接已打开的 Chrome）...');

  let cookies = [];
  if (fs.existsSync('./cookies.json')) {
    cookies = JSON.parse(fs.readFileSync('./cookies.json', 'utf8'));
    console.log('[抢购] 已读取 cookies，共', cookies.length, '条');
  }

  console.log('[步骤1] 正在连接本机 Chrome（端口 9222）...');
  const portOpen = await checkPort9222();
  if (!portOpen) {
    console.error('[步骤1-失败] 端口 9222 无响应（ECONNREFUSED），说明当前没有「带调试端口」的 Chrome。');
    console.error('');
    console.error('正确做法（顺序不能错）：');
    console.error('  1. 任务管理器 → 结束所有「Google Chrome」/ chrome.exe（关窗口不够，要进程退出）');
    console.error('  2. 在本目录 PowerShell 执行: .\\start-chrome-debug.ps1');
    console.error('  3. 弹出的是「唯一」的 Chrome，在该窗口里登录并打开活动页');
    console.error('  4. 再运行: node buy-cdp.js');
    console.error('');
    console.error('验证：Chrome 用脚本启动后，在地址栏打开 http://127.0.0.1:9222/json 应能看到 JSON。');
    process.exit(1);
  }

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    console.error('[步骤1-失败] CDP 连接失败:', e.message || e);
    console.error('若 9222 已开放，请确认本机安装的是 Chromium/Chrome，且 Playwright 版本支持 CDP。');
    process.exit(1);
  }
  console.log('[步骤1] 已连接 Chrome（CDP）');

  const contexts = browser.contexts();
  const context = contexts[0] || await browser.newContext();
  if (cookies.length > 0) {
    await context.addCookies(cookies);
  }

  let page = null;
  const pages = context.pages();
  console.log('[步骤2] 选择含目标商品的活动页（共', pages.length, '张标签）...');
  // 思路：
  // 1. 浏览器可能开了多张活动页标签，必须选中包含目标商品「约3.17元/月」的那张，
  //    否则会连到没有目标卡片的标签，一直卡在等待
  // 2. 任一标签读取失败（如正在导航）时跳过，不影响其他标签
  for (const p of pages) {
    try {
      if (p.url().includes('cloud.tencent.com') && p.url().includes('act')) {
        const hasTarget = await p.locator('.uno3-buy-card__ft')
          .filter({ hasText: '约3.17元/月' }).count();
        if (hasTarget > 0) {
          page = p;
          console.log('[步骤2] 已选中含目标商品的活动页:', p.url().slice(0, 120));
          break;
        }
      }
    } catch (_) {}
  }
  // 兜底：没有任何标签含目标商品时，退回第一张活动页
  if (!page) {
    for (const p of pages) {
      try {
        if (p.url().includes('cloud.tencent.com') && p.url().includes('act')) {
          page = p;
          console.log('[步骤2-警告] 未找到含目标商品的标签，退回第一张活动页（可能一直等不到按钮）');
          break;
        }
      } catch (_) {}
    }
  }
  if (!page && pages.length > 0) {
    page = pages[0];
    console.log('[抢购] 在当前标签页打开活动页...');
    await page.goto(ACTIVITY_URL);
  }
  if (!page) {
    page = await context.newPage();
    console.log('[抢购] 在新标签页打开活动页...');
    await page.goto(ACTIVITY_URL);
  }

  console.log('[步骤3] 注入页内 MutationObserver 监听（检测+点击均在页内）...');

  // 思路：
  // 1. 检测+点击全部放页内完成：省掉 Node↔Playwright 跨进程往返和 Playwright
  //    click 的可操作性检查，按钮一变成立即点击（1ms 级），这是提速关键
  // 2. Vue 重渲染会替换按钮节点，所以监听整个 documentElement 的节点增删
  //    和 class 变化，且节点引用断开时重新查找卡片
  // 3. 抽成函数是为了页面整页刷新后能重复注入（开抢前活动页会刷新）
  // 4. 上一场残留的售罄弹窗先关掉，避免遮挡后续操作
  const injectObserver = async (targetPage) => {
    try {
      const injectResult = await targetPage.evaluate(() => {
      document.querySelectorAll('.uno3-dialog').forEach((dialog) => {
        if ((dialog.innerText || '').includes('已售罄')) {
          const confirmBtn = Array.from(dialog.querySelectorAll('button'))
            .find((b) => (b.innerText || '').trim() === '确定');
          if (confirmBtn) confirmBtn.click();
        }
      });
      // 版本号：注入逻辑改动后必须 +1，否则旧注入存活时新代码被
      // 'already' 跳过（15:08 重启实测踩坑：改了三处优化全没生效）
      const INJECT_VER = 10;
      if (window.__snatch) {
        if (window.__snatch.ver === INJECT_VER) return 'already';
        return 'stale';
      }

      const state = { buyClicked: false, sidebarClicked: false, log: [], lastClickTs: 0, ver: INJECT_VER };
      window.__snatch = state;
      let card = null;
      let btn = null;

      const findBtn = () => {
        if (btn && btn.isConnected) return btn;
        if (!card || !card.isConnected) {
          card = Array.from(document.querySelectorAll('.uno3-buy-card__ft'))
            .find((e) => (e.innerText || '').includes('约3.17元/月')) || null;
        }
        btn = card ? card.querySelector('.uno3-buy-card__btn') : null;
        return btn;
      };

      const tick = () => {
        // 售罄弹窗：自动关闭并复位点击标记，让补库存后能再次触发抢购
        const soldOut = Array.from(document.querySelectorAll('.uno3-dialog'))
          .find((d) => (d.innerText || '').includes('已售罄'));
        if (soldOut && !state.soldOutHandled) {
          state.soldOutHandled = true;
          const ok = Array.from(soldOut.querySelectorAll('button'))
            .find((b) => (b.innerText || '').trim() === '确定');
          if (ok) ok.click();
          state.buyClicked = false;
          state.log.push('@soldout-reset');
        }
        if (!soldOut) state.soldOutHandled = false;

        const buyBtn = findBtn();
        if (buyBtn) {
          const text = (buyBtn.innerText || '').trim();
          if (state.log[state.log.length - 1] !== text) state.log.push(text);
          // 冷却 1500ms：15:00 场实测页面狂点是 408 限频主因。
          // 直连为主力后页面点击仅兜底，放慢点击频率避免拖累直连请求配额
          const cooledDown = Date.now() - state.lastClickTs > 1500;
          if (text === '立即抢购' && !state.buyClicked && cooledDown) {
            state.buyClicked = true;
            state.lastClickTs = Date.now();
            state.log.push('@click-buy');
            buyBtn.click();
            // 页面点击的同时，直连接口也打一发（直连为主力，双保险）
            if (state.fireDirect) state.fireDirect('btn');
          }
        }
        if (state.buyClicked && !state.sidebarClicked) {
          const dialog = document.querySelector('.uno3-buy-dialog');
          if (dialog) {
            const sideBtn = Array.from(dialog.querySelectorAll('.uno3-dialog-footer-btn button'))
              .find((b) => (b.innerText || '').includes('立即购买'));
            if (sideBtn) {
              state.sidebarClicked = true;
              state.log.push('@click-sidebar');
              sideBtn.click();
            }
          }
        }
      };

      // ---- 直连 do-goods 下单 ----
      // 思路：
      // 1. 复用页面自己的签名模块（webpack require 8579 的 dm.ge/dm.he），
      //    无需逆向算法；X-CSRF-TOKEN = skey 的 djb2 哈希（源码确认）
      // 2. 目标商品信息提前缓存，整点触发时只做 签名+POST（毫秒级），
      //    避免现场查接口浪费 100~300ms
      // 3. goods/agent_channel/business 结构经 9 轮服务端错误提示校准，
      //    实测返回 1100136 售罄（参数、签名、CSRF 全部通过）
      const ACT_ID = 166111704417621;
      // 并发射击：10:00 场实测首发耗时 1.55s，原来的串行锁把 T-1500→T+0 的
      // 整个窗口全堵死，黄金那一发（T+0）因「在途」被直接丢弃。
      // 改为并发上限 3 + 单发 1.5s 超时中断：慢回包只占一个槽位，不阻塞后续火力
      state.cachedGoods = state.cachedGoods || null;
      state.directSuccess = false;
      state.directCooldownUntil = 0;
      state.inFlight = 0;
      state.retryTimer = null;
      state.retryUntil = 0;
      state.soldOutAt = 0;
      // 15:00 场实测推翻了「服务端排队 1.4s、需提前开火」的假设：
      //   T-1600 / T-1450 / T-1300 三发在 370ms 内连续被 408「访问频率过快」
      //   秒拒 —— 说明服务端对超频请求是快速拒绝，密集前置火力打的是自己的
      //   限流配额，1.1 秒的黄金窗口全耗在冷却里空转。
      // 改为「少而准」：并发 2、只打 4 发、408 冷却缩到 120ms
      const MAX_CONCURRENCY = 2;
      // 不软释放过早：并发 2 下若 1.5s 就释放，实际会叠成 3~4 发并发，反而触发限流
      const SHOT_TIMEOUT = 2500;
      const COOLDOWN_MS = 120;
      // 售罄后低频探测：15:00 场实测 15:00:11.8 按钮又回到「立即抢购」，
      // 说明库存会回池（未支付超时 / 限流丢弃释放），2.5 秒一发探 60 秒
      const PROBE_INTERVAL = 2500;
      const PROBE_WINDOW = 60000;
      // 安全阀：总量上限，避免把 IP/账号打到限频黑名单
      const MAX_SHOTS = 40;
      state.shotCount = 0;

      // 售罄后的低频探测循环（不是补射）：
      // 2.5 秒一发、持续 60 秒，专门捕捉库存回池；只有抢到才停火。
      // 15:00 场原逻辑在收到 1100136 后立刻彻底停火，而实测 T+11.8s
      // 按钮又回到「立即抢购」，回池的库存被白白错过
      function stopRetry(reason) {
        if (!state.retryTimer) return;
        clearInterval(state.retryTimer);
        state.retryTimer = null;
        state.log.push('@direct-probe-stop:' + reason);
      }

      function startRetry(untilTs) {
        if (state.retryTimer) { state.retryUntil = untilTs; return; }
        state.retryUntil = untilTs;
        state.log.push('@direct-probe-start');
        state.retryTimer = setInterval(() => {
          if (state.directSuccess) { stopRetry('success'); return; }
          if (Date.now() > state.retryUntil) { stopRetry('timeout'); return; }
          if (Date.now() < state.directCooldownUntil) return;
          state.fireDirect('retry');
        }, PROBE_INTERVAL);
      }

      const fetchGoodsCache = async () => {
        const r = await fetch('https://act-api.cloud.tencent.com/dianshi/query-seckill-by-date', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ activity_id: ACT_ID, preview: 0, seckill_type: 'block', goods_type: 'goods', days: 2 })
        });
        const j = await r.json();
        const flash = (j.data && j.data.flashResult) || {};
        let target = null;
        for (const day of Object.keys(flash)) {
          for (const group of flash[day] || []) {
            for (const item of group.sales || []) {
              const sku = ((item.seckill_act_extra || {}).skuList || []).join(' ');
              if (sku.includes('4核4G3M')) { target = item; break; }
            }
          }
        }
        if (!target) throw new Error('接口无目标商品');
        state.cachedGoods = { ts: Date.now(), target };
      };

      state.fireDirect = async (reason) => {
        if (state.directSuccess) return;
        // 并发上限：慢回包只占一个槽位，不阻塞后续发射（原串行锁丢枪问题）
        if (state.inFlight >= MAX_CONCURRENCY) {
          const nowBusy = Date.now();
          if (!state.lastBusyLog || nowBusy - state.lastBusyLog > 2000) {
            state.lastBusyLog = nowBusy;
            state.log.push(`@direct-skip-busy(${state.inFlight})`);
          }
          return;
        }
        // 408 限频退避：实测 1.8s 冷却比整个抢购窗口还长，缩短到 400ms
        if (Date.now() < state.directCooldownUntil) {
          const nowCd = Date.now();
          if (!state.lastCdLog || nowCd - state.lastCdLog > 2000) {
            state.lastCdLog = nowCd;
            state.log.push('@direct-skip-cd');
          }
          return;
        }
        // 安全阀只统计真正发出的请求，被跳过的不计入（否则配额被空转吃掉）
        state.shotCount += 1;
        if (reason === 'retry' && state.shotCount > MAX_SHOTS) {
          stopRetry('max-shots');
          return;
        }
        state.inFlight += 1;
        // 槽位软释放：慢请求超过 SHOT_TIMEOUT 只释放并发槽、让后续火力继续，
        // 但绝不中断请求本身 —— 服务端可能已经受理，中断会丢失成功结果
        let slotReleased = false;
        const releaseSlot = () => {
          if (slotReleased) return;
          slotReleased = true;
          state.inFlight -= 1;
        };
        const slotTimer = setTimeout(() => {
          releaseSlot();
          state.log.push(`@direct-slow(>${SHOT_TIMEOUT}ms,s槽位已释放)`);
        }, SHOT_TIMEOUT);
        try {
          // 缓存 90 秒内不重查，整点开火时零查询延迟
          if (!state.cachedGoods || Date.now() - state.cachedGoods.ts > 90000) {
            await fetchGoodsCache();
          }
          const target = state.cachedGoods.target;
          const g = window['webpackChunk_tencent_qcact_ssr'];
          if (!g) throw new Error('webpack runtime 不存在（页面结构变化）');
          let req = null;
          g.push([[`d${Date.now()}`], {}, (r) => { req = r; }]);
          if (typeof req !== 'function') throw new Error('require 获取失败');
          const dm = req(8579).dm;
          const signHeader = await dm.he();
          const cookies = {};
          document.cookie.split(';').forEach((kv) => {
            const i = kv.indexOf('=');
            if (i > 0) cookies[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
          });
          const skey = cookies.skey || cookies.p_skey || '';
          if (!skey) throw new Error('未登录（无 skey cookie）');
          let h = 5381;
          for (let i = 0; i < skey.length; i++) h += (h << 5) + skey.charCodeAt(i);
          const csrf = String(2147483647 & h);
          const urlParams = new URLSearchParams(location.search);
          const fromChannel = urlParams.get('source') || urlParams.get('channel')
            || urlParams.get('from_channel') || '';
          const body = {
            activity_id: ACT_ID,
            goods: [{
              act_id: target.act_id,
              type: (target.defaultOrderParam || {}).type,
              goods_param: target.defaultOrderParam || {}
            }],
            preview: 0,
            agent_channel: { fromChannel, fromSales: '', isAgentClient: false, fromUrl: location.href },
            business: {}
          };
          const endpoint = 'https://act-api.cloud.tencent.com/dianshi/do-goods';
          const signArr = ['post', undefined, new URL(endpoint).pathname, undefined, {},
            undefined, body, undefined, undefined, navigator.userAgent, skey];
          const [sign] = await dm.ge(signArr, Date.now());
          const resp = await fetch(endpoint, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
              'X-CSRF-TOKEN': csrf,
              [signHeader]: String(sign)
            },
            body: JSON.stringify(body)
          });
          const json = await resp.json().catch(() => ({}));
          state.log.push(`@direct:${reason}:${resp.status}:${json.code}:${String(json.msg || '').slice(0, 50)}`);
          // 408/432 限频：短冷却 120ms（实测 408 是 370ms 快速拒绝，
          // 400ms 冷却在 1.1 秒的窗口里等于直接放弃这一场）
          if (resp.status === 408 || resp.status === 432 || json.code === 408) {
            state.directCooldownUntil = Date.now() + COOLDOWN_MS;
          }
          // 1100136 = 已售罄（业务码）：不再停火 —— 实测库存会回池，
          // 交给 2.5 秒低频探测继续捕捉；只记录首次售罄时刻用于日志分析
          if (json.code === 1100136 && !state.soldOutAt) {
            state.soldOutAt = Date.now();
          }
          // 1101408 = 当前系统繁忙：服务端过载，降低节奏但不停止
          if (json.code === 1101408) {
            state.directCooldownUntil = Date.now() + COOLDOWN_MS * 3;
          }
          if (json.code === 0 || (resp.status === 200 && json.code === undefined && json.data)) {
            state.directSuccess = true;
            stopRetry('success');
            state.log.push('@direct-SUCCESS:' + JSON.stringify(json.data || {}).slice(0, 300));
          }
        } catch (e) {
          state.log.push('@direct-err:' + (e.message || e));
        } finally {
          clearTimeout(slotTimer);
          releaseSlot();
        }
      };

      // 整点定时开火：10:00 / 15:00
      // 15:00 场实测结论（推翻了 10:00 场时的猜测）：
      //   - 服务端对「超频请求」是 370ms 快速 408 拒绝，不是排队；
      //     只有正常单发请求才要 ~1.1 秒处理（RTT 实测 147~262ms）
      //   - 库存 1.1 秒售罄（15:00:01.100 返回 1100136）
      //   - 页面按钮 T+1.348s 才亮，晚于售罄 → 页面点击路径对这个 SKU 永远抢不到
      //   - 三发 0.37 秒内齐射即触发限流，阈值约 2 次/秒
      // 因此不再提前开火、不再密集齐射：只打 4 发，间隔 ≥400ms，
      // 发送时刻比整点早 150ms（抵消 200ms RTT，让请求在 T+50 抵达服务端）
      const scheduleDirect = () => {
        // shots 为相对整点的绝对时刻偏移，各自独立 setTimeout 到墙钟时刻，
        // 不依赖调用时机（负 delay 会立即触发，不能直接用）
        const shots = [-150, 200, 600, 1100];
        const fireAt = (ts, offset, isFirst) => {
          setTimeout(() => {
            if (state.directSuccess) return;
            state.log.push(`@direct-fire T${offset >= 0 ? '+' : ''}${offset}ms`);
            state.fireDirect('burst');
            // 首发起启动 60 秒低频探测（2.5 秒一发），专门捕捉回池库存
            if (isFirst) startRetry(ts + PROBE_WINDOW);
          }, Math.max(0, ts - Date.now() + offset));
        };
        const now = Date.now();
        const nextShots = [];
        for (const hour of [10, 15]) {
          const t = new Date();
          t.setHours(hour, 0, 0, 0);
          if (t.getTime() <= now) t.setDate(t.getDate() + 1);
          nextShots.push(t.getTime());
        }
        for (const ts of nextShots) {
          // 提前 2600ms 预热商品缓存（burst 首发前就绪，首发零查询延迟）
          setTimeout(() => { fetchGoodsCache().catch(() => {}); }, Math.max(0, ts - now - 2600));
          // 从 T-150ms 起开火，SESSION 标记打在整点
          shots.forEach((offset, idx) => fireAt(ts, offset, idx === 0));
          setTimeout(() => { state.log.push(`@direct-SESSION ${new Date(ts).toTimeString().slice(0, 8)}`); }, ts - now);
        }
        state.log.push(`@direct-scheduled ${nextShots.map((ts) => new Date(ts).toTimeString().slice(0, 8)).join(',')}`);
      };

      new MutationObserver(tick).observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'disabled'],
      });
      tick();
      scheduleDirect();
      return 'injected';
      });
      if (injectResult === 'stale') {
        console.log('[步骤3] 检测到旧版注入（无直连能力），刷新页面重新注入...');
        await targetPage.reload({ waitUntil: 'load', timeout: 30000 });
        await new Promise((r) => setTimeout(r, 2500));
        return await injectObserver(targetPage);
      }
      if (injectResult !== 'injected' && injectResult !== 'already') {
        console.error('[步骤3-失败] 注入监听返回未知结果:', injectResult);
        return false;
      }
      console.log('[步骤3] 观察器已注入（', injectResult, '）');
      return true;
    } catch (e) {
      console.error('[步骤3-失败] 注入监听失败:', e.message || e);
      return false;
    }
  };
  if (!(await injectObserver(page))) process.exit(1);
  console.log('[步骤3] 进入守候状态');
  const stockMonitor = startStockMonitor();

  // 思路：
  // 1. 开抢前活动页整页刷新会使观察器消失（14:59 实测发生过），不是致命错误：
  //    等页面加载完重新注入即可继续守，直接退出会错过开抢
  // 2. 若已离开腾讯云域名（如跳登录页），重新打开活动页
  // 3. 连续恢复 10 次失败才退出，避免无意义死循环
  const recoverPage = async () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
        // 重新选页：跟踪的标签可能被跳转到非活动页（08:55 实测：跳到
        // console 页后被继续注入，真正的活动页反而没观察器）。
        // 必须重新扫描全部标签找含目标商品的那张，找不到才退回 goto 活动页
        const contextPages = context.pages();
        let targetPage = null;
        for (const p of contextPages) {
          try {
            if (p.url().includes('cloud.tencent.com')) {
              const has = await p.locator('.uno3-buy-card__ft')
                .filter({ hasText: '约3.17元/月' }).count();
              if (has > 0) { targetPage = p; break; }
            }
          } catch (_) {}
        }
        if (targetPage) {
          if (targetPage !== page) console.log(`[恢复-第${attempt}次] 重新选中含目标商品的标签:`, targetPage.url().slice(0, 90));
          page = targetPage;
        } else if (!page.url().includes('act')) {
          console.log(`[恢复-第${attempt}次] 当前页非活动页（${page.url().slice(0, 80)}），重新打开...`);
          await page.goto(ACTIVITY_URL, { waitUntil: 'load', timeout: 30000 });
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (await injectObserver(page)) {
          // 目标页可能残留此前的静默标记，恢复为守候状态
          await page.evaluate(() => {
            if (window.__snatch) window.__snatch.directSuccess = false;
          }).catch(() => {});
          return true;
        }
      } catch (e) {
        console.log(`[恢复-第${attempt}次] 失败:`, e.message || e);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  };

  // 思路：
  // 1. Node 侧只读状态打日志，点击全部由页内观察器完成
  // 2. 一轮「点击→等侧边栏」失败（售罄）不退出：观察器已复位 buyClicked，
  //    继续守下一次「立即抢购」（补库存/下一场），直到侧边栏点击成功
  // 3. 页面刷新导致状态丢失不退出：自动恢复并重新注入观察器，继续守
  //    （开抢前活动页会整页刷新，直接退出会错过开抢）
  const readState = () => page.evaluate(() => window.__snatch || null).catch(() => null);
  let printed = 0;
  let succeeded = false;
  let round = 0;

  while (!succeeded) {
    round += 1;
    // 阶段一：等待页内把「立即抢购」点掉（可能已由上一轮触发，直接跳过）
    console.log(`[步骤4-第${round}轮] 等待按钮变为「立即抢购」...`);
    let clicked = false;
    while (!clicked) {
      const state = await readState();
      if (!state) {
        // 页面刷新/导航导致观察器消失：恢复后重新注入，而非退出
        console.log(`[步骤4-第${round}轮] 页面状态丢失（刷新或跳转），启动恢复...`);
        const recovered = await recoverPage();
        if (!recovered) {
          console.error(`[步骤4-第${round}轮-失败] 连续 10 次恢复失败，脚本退出`);
          stockMonitor.stop();
          process.exit(1);
        }
        console.log(`[步骤4-第${round}轮] 恢复成功，重新注入观察器，继续守候`);
        printed = 0;
        continue;
      }
      while (printed < state.log.length) {
        const entry = state.log[printed++];
        if (entry === '@click-buy') console.log(`[步骤4-第${round}轮] 检测到可抢购，页内已直接点击「立即抢购」`);
        else if (entry === '@click-sidebar') console.log(`[步骤4-第${round}轮] 页内已点击侧边栏「立即购买」`);
        else if (entry === '@soldout-reset') console.log(`[步骤4-第${round}轮] 售罄弹窗已自动关闭，继续守下一次抢购...`);
        else if (entry.startsWith('@direct')) console.log(`[步骤4-第${round}轮] [直连]`, entry.replace(/^@direct-?/, ''));
        else console.log(`[步骤4-第${round}轮] 按钮状态:`, entry || '(空)');
      }
      clicked = state.buyClicked;
      if (state.directSuccess) {
        console.log('[步骤4] ✅ 直连接口下单成功，请到页面完成支付');
        succeeded = true;
        break;
      }
      if (clicked && state.sidebarClicked) { succeeded = true; break; }
      if (!clicked) await new Promise((r) => setTimeout(r, 50));
    }
    if (succeeded) break;

    // 阶段二：等侧边栏（15 秒）；新标签页则 Playwright 兜底
    console.log(`[步骤5-第${round}轮] 已点击抢购按钮，等待侧边栏「立即购买」（15秒超时）...`);
    let newPage = null;
    context.waitForEvent('page', { timeout: 15000 })
      .then((p) => { newPage = p; })
      .catch(() => {});
    const sidebarDeadline = Date.now() + 15000;
    while (Date.now() < sidebarDeadline && !newPage) {
      const state = await readState();
      if (!state) {
        console.log(`[步骤5-第${round}轮] 读取页内状态失败（页面可能导航中）`);
        break;
      }
      while (printed < state.log.length) {
        const entry = state.log[printed++];
        if (entry === '@click-sidebar') console.log(`[步骤5-第${round}轮] 页内已点击侧边栏「立即购买」`);
        else if (entry === '@soldout-reset') console.log(`[步骤5-第${round}轮] 售罄弹窗已自动关闭，继续守下一次抢购...`);
        else if (entry.startsWith('@direct')) console.log(`[步骤5-第${round}轮] [直连]`, entry.replace(/^@direct-?/, ''));
        else console.log(`[步骤5-第${round}轮] 按钮状态:`, entry || '(空)');
      }
      if (state.directSuccess) {
        console.log('[步骤5] ✅ 直连接口下单成功，请到页面完成支付');
        succeeded = true;
        break;
      }
      if (state.sidebarClicked) { succeeded = true; break; }
      // 本轮已被售罄复位：立刻回到阶段一守下一次，不空等满 15 秒
      if (!state.buyClicked && state.log.includes('@soldout-reset')) {
        console.log(`[步骤5-第${round}轮] 本轮已售罄复位，提前结束等待`);
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    if (newPage) {
      page = newPage;
      console.log(`[步骤5-第${round}轮] 检测到新标签页，切换过去等待侧边栏...`);
      try {
        const sideBtn = page.locator('.uno3-buy-dialog .uno3-dialog-footer-btn button')
          .filter({ hasText: '立即购买' }).first();
        await sideBtn.waitFor({ state: 'visible', timeout: 15000 });
        await sideBtn.click();
        succeeded = true;
      } catch (e) {
        console.error(`[步骤5-第${round}轮-失败] 新标签页未找到侧边栏「立即购买」:`, e.message || e);
      }
      break;
    }

    if (!succeeded) {
      const state = await readState();
      console.log(`[步骤5-第${round}轮-结果] 未出现侧边栏（售罄），继续守库存。按钮历史:`,
        state ? state.log.slice(-10).join(' -> ') : '状态丢失');
      // 等观察器复位完成（售罄弹窗关闭），再进入下一轮
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  stockMonitor.stop();
  console.log(`[步骤6] 成功！共尝试 ${round} 轮，侧边栏「立即购买」已点击，请在页面完成下单。`);
  await browser.close();
  console.log('[步骤6] 已断开连接，Chrome 窗口保持打开，可继续手动操作。');
})().catch((e) => {
  // 思路：任何未捕获异常都要落到日志，否则脚本静默退出后无从排查
  console.error('[致命错误] 脚本异常退出:', e && (e.stack || e.message) || e);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[致命错误] 未处理的 Promise 拒绝:', reason instanceof Error ? (reason.stack || reason.message) : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[致命错误] 未捕获异常:', err && (err.stack || err.message) || err);
  process.exit(1);
});
