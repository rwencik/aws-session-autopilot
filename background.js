const LEGACY_STATE_KEY = 'aws_fifo_state';
const TEMP_KEY = 'aws_fifo_temporary';
const LOGOUT_RE = /^\/sessions\/[^/]+\/v1\/logout\/?$/;
const LIMIT_RE = /^\/sessions\/limit\/?$/;
const TTL = 5 * 60 * 1000;
const RETRY_GUARD_TTL = 2 * 60 * 1000;
let queue = Promise.resolve();
function locked(fn) {
  const result = queue.then(fn, fn);
  queue = result.catch(() => {});
  return result;
}
async function getTemp() {
  const stored = (await chrome.storage.session.get(TEMP_KEY))[TEMP_KEY] || {};
  // Only short-lived, in-browser state. Account observations are never
  // persisted in local storage or shown in the extension's UI.
  return {
    pending: {}, launches: {}, tabOrigins: {}, seenIdentities: {},
    retryGuard: null, diagnostic: 'Automatic mode active',
    ...stored,
    retryGuard: stored.retryGuard || null
  };
}
async function saveTemp(temp) {
  await chrome.storage.session.set({ [TEMP_KEY]: temp });
}
async function status(message) {
  console.info('[AWS Session FIFO]', message);
  await locked(async () => {
    const temp = await getTemp();
    temp.diagnostic = message;
    temp.diagnosticTime = Date.now();
    await saveTemp(temp);
  });
}
function identity(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const m = hostname.match(/^(\d{12}-[a-z0-9-]+)\.(?:(?:[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d+)\.)?console\.aws\.amazon\.com$/);
    return m ? m[1] : null;
  } catch { return null; }
}
async function track(url) {
  const id = identity(url);
  if (!id) return;
  await locked(async () => {
    const tmp = await getTemp();
    const fresh = !tmp.seenIdentities[id];
    tmp.seenIdentities[id] = Date.now();
    // Limit ephemeral bookkeeping; this is NOT the AWS active-session count.
    const ids = Object.entries(tmp.seenIdentities).sort((a,b) => b[1]-a[1]);
    tmp.seenIdentities = Object.fromEntries(ids.slice(0, 100));
    const guard = tmp.retryGuard;
    if (fresh && guard && guard.phase === 'awaiting-console' && Date.now() >= guard.startedAt) {
      tmp.retryGuard = null;
      tmp.diagnostic = 'New AWS Console session detected; ready for next account';
      tmp.diagnosticTime = Date.now();
    }
    await saveTemp(tmp);
  });
}
function isPortal(url) {
  try { return new URL(url).hostname.toLowerCase().endsWith('.awsapps.com'); }
  catch { return false; }
}
// Never store or replay SAML assertions, federation links, OAuth codes or signed URLs.
// Safe replay is limited to ordinary AWS access-portal links without query strings.
function safePortalEntry(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !isPortal(url) || u.search) return null;
    if (/\/(saml|federation|oauth|callback|token|logout)(\/|$)/i.test(u.pathname)) return null;
    return u.href;
  } catch { return null; }
}
function validSigninPage(url, kind) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /^([a-z0-9-]+\.)?signin\.aws\.amazon\.com$/i.test(u.hostname)
      && (kind === 'limit' ? LIMIT_RE : LOGOUT_RE).test(u.pathname);
  } catch { return false; }
}
chrome.tabs.onCreated.addListener(tab => {
  if (!Number.isInteger(tab.id)) return;
  locked(async () => {
    const tmp = await getTemp();
    if (Number.isInteger(tab.openerTabId)) {
      tmp.tabOrigins[tab.id] = {sourceTabId: tab.openerTabId, at: Date.now()};
    } else {
      // Some portals use target=_blank with noopener. Associate a tab only when
      // exactly one source had a genuine user click in the last 15 seconds.
      const candidates = Object.entries(tmp.launches).filter(([,v]) => Date.now() - v.at < 15000);
      if (candidates.length === 1) {
        tmp.tabOrigins[tab.id] = {sourceTabId: Number(candidates[0][0]), at: Date.now()};
      }
    }
    await saveTemp(tmp);
  });
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if ((change.url || change.status === 'complete') && tab.url) track(tab.url).catch(console.error);
  if (!change.url) return;
  const safeEntry = safePortalEntry(change.url);
  if (safeEntry) {
    locked(async () => {
      const tmp = await getTemp();
      const origin = tmp.tabOrigins[tabId] || {};
      tmp.tabOrigins[tabId] = {...origin, entryUrl: safeEntry, at: Date.now()};
      await saveTemp(tmp);
    });
  }
});
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'DIAGNOSTIC') {
    status(msg.message).then(()=>reply({ok:true})).catch(e=>reply({error:String(e)}));
    return true;
  }
  if (msg.type === 'PORTAL_LAUNCH') {
    (async()=>{
      if (!Number.isInteger(sender.tab?.id) || !isPortal(sender.tab.url)) {reply({ok:false});return;}
      await locked(async()=>{
        const tmp = await getTemp();
        tmp.launches[sender.tab.id] = {at: Date.now()};
        // A new, real user click allows a new replacement after a failed retry.
        tmp.retryGuard = null;
        await saveTemp(tmp);
      });
      reply({ok:true});
    })().catch(e=>reply({ok:false,error:String(e)}));
    return true;
  }
  if (msg.type === 'ARM_CLOSE_ON_LOGOUT') {
    (async()=>{
      const tab = sender.tab;
      if (!Number.isInteger(tab?.id) || !validSigninPage(tab.url,'limit')) {reply({ok:false,reason:'Not an AWS limit page'});return;}
      const result = await locked(async()=>{
        const tmp = await getTemp();
        const guard = tmp.retryGuard;
        if (guard && Date.now() < guard.expiresAt) {
          return {ok:false, reason:'Safety stop: automatic retry reached the session limit again; no successful AWS Console login detected'};
        }
        // Expired guards cannot affect subsequent independent sign-ins.
        if (guard) tmp.retryGuard = null;
        const portalTabId = tmp.tabOrigins[tab.id]?.sourceTabId || tab.openerTabId;
        let sourceTabId = null;
        if (Number.isInteger(portalTabId) && Date.now() - (tmp.launches[portalTabId]?.at || 0) < TTL) {
          sourceTabId = portalTabId;
        } else {
          // Covers browsers where tab.openerTabId is unavailable because of noopener.
          const recent = Object.entries(tmp.launches).filter(([,v])=>Date.now()-v.at<TTL);
          if (recent.length === 1) sourceTabId=Number(recent[0][0]);
        }
        tmp.pending[tab.id] = {
          at: Date.now(), sourceTabId,
          entryUrl: tmp.tabOrigins[tab.id]?.entryUrl || null
        };
        // Fail closed if the retry creates a second limit screen. The new session
        // must be verified by a real human action before another sign-out.
        tmp.retryGuard = {
          startedAt: Date.now(),
          expiresAt: Date.now() + RETRY_GUARD_TTL,
          phase: 'signing-out',
          sourceTabId
        };
        await saveTemp(tmp);
        return {ok:true, retryAvailable: Number.isInteger(sourceTabId) || !!tmp.pending[tab.id].entryUrl};
      });
      reply(result);
    })().catch(e=>reply({ok:false,error:String(e)}));
    return true;
  }
  if (msg.type === 'LOGOUT_CONFIRMED') {
    (async()=>{
      const tab=sender.tab;
      if (!Number.isInteger(tab?.id) || !validSigninPage(tab.url,'logout')) {reply({ok:false});return;}
      const {pending, retry} = await locked(async()=>{
        const tmp=await getTemp();
        const entry=tmp.pending[tab.id];
        if (!entry || Date.now()-entry.at > 120000) return {pending:null,retry:false};
        delete tmp.pending[tab.id];
        await saveTemp(tmp);
        return {pending:entry,retry:true};
      });
      if (!pending) {reply({ok:false});return;}
      // Close only after AWS visibly confirms sign-out. Keep a guard only
      // while a programmatic retry could create a sign-in loop.
      let result='AWS confirmed sign-out; logout tab closed';
      let retried=false;
      if (retry && Number.isInteger(pending.sourceTabId)) {
        await locked(async () => {
          const tmp = await getTemp();
          if (tmp.retryGuard) tmp.retryGuard.phase = 'awaiting-console';
          await saveTemp(tmp);
        });
      }
      if (retry && Number.isInteger(pending.sourceTabId)) {
        try {
          const portalTab=await chrome.tabs.get(pending.sourceTabId);
          if (isPortal(portalTab.url)) {
            const response=await chrome.tabs.sendMessage(pending.sourceTabId, {type:'RETRY_PORTAL_LAUNCH'});
            if (response?.ok) {
              retried=true;
              result='AWS signed out oldest; attempted original portal launch (browser may block a new tab)';
            }
          }
        } catch (e) {
          result='AWS signed out oldest; portal retry unavailable: '+String(e.message||e);
        }
      }
      if (retry && !retried && pending.entryUrl) {
        // Navigating to a clean, non-tokenized access portal entry is safe.
        try {
          await chrome.tabs.update(tab.id,{url:pending.entryUrl});
          result='AWS signed out oldest; returned to access portal (select account again)';
        } catch (e) { result='AWS signed out oldest; could not return to portal: '+String(e.message||e); }
      }
      // A completed manual sign-out or a portal navigation (without actually
      // replaying the click) cannot cause an automatic retry loop.
      if (!retried) {
        await locked(async () => {
          const tmp = await getTemp();
          tmp.retryGuard = null;
          await saveTemp(tmp);
        });
      }
      if (!pending.entryUrl || retried || Number.isInteger(pending.sourceTabId)) {
        await chrome.tabs.remove(tab.id).catch(()=>{});
      }
      await status(result);
      reply({ok:true,retried});
    })().catch(e=>reply({ok:false,error:String(e)}));
    return true;
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  locked(async()=>{
    const tmp=await getTemp();
    delete tmp.pending[tabId];
    delete tmp.launches[tabId];
    delete tmp.tabOrigins[tabId];
    await saveTemp(tmp);
  });
});
chrome.runtime.onInstalled.addListener(async (details) => {
  // Upgrading from v0.7 removes its persistent observations and old toggles.
  await chrome.storage.local.remove(LEGACY_STATE_KEY).catch(() => {});
  await locked(async () => {
    const tmp = await getTemp();
    if (details?.reason === 'update') {
      // Prevent old retry state from blocking the first login after upgrade.
      tmp.retryGuard = null;
      tmp.pending = {};
    }
    await saveTemp(tmp);
  });
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) if (tab.url) await track(tab.url);
});
