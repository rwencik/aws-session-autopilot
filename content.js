(() => {
  if (window.top !== window) return;
  // Remember the actual access-portal element clicked by the user, not the
  // resulting federation URL. A fresh click can obtain new one-time credentials.
  if (location.hostname.endsWith('.awsapps.com')) {
    let lastLaunch = null;
    document.addEventListener('click', event => {
      if (!event.isTrusted) return;
      const element = event.target?.closest?.('a,button,[role="link"],[role="button"]');
      if (!element) return;
      lastLaunch = {element, at: Date.now()};
      chrome.runtime.sendMessage({type:'PORTAL_LAUNCH'}).catch(()=>{});
    }, true);
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (msg.type !== 'RETRY_PORTAL_LAUNCH') return;
      if (!lastLaunch || Date.now()-lastLaunch.at > 5*60*1000 || !lastLaunch.element.isConnected) {
        reply({ok:false,reason:'Original portal link no longer available'});
        return;
      }
      try {
        lastLaunch.element.click();
        reply({ok:true});
      } catch (error) { reply({ok:false,reason:String(error)}); }
    });
  }
  if (/^\/sessions\/[^/]+\/v1\/logout\/?$/.test(location.pathname)) {
    let reported = false;
    const check = () => {
      if (reported || !/you(?:'|’)?ve signed out of the/i.test(document.body?.innerText || '')) return;
      reported = true;
      chrome.runtime.sendMessage({type:'LOGOUT_CONFIRMED'}).catch(()=>{});
    };
    new MutationObserver(check).observe(document.documentElement, {subtree:true,childList:true,characterData:true});
    check();
    return;
  }
  const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const delay = ms => new Promise(r => setTimeout(r, ms));
  let busy = false, completed = false, lastStatus = '';
  const report = (status, extra = {}) => {
    const message = `${status}${Object.keys(extra).length ? ' · ' + JSON.stringify(extra) : ''}`;
    if (message === lastStatus) return;
    lastStatus = message;
    chrome.runtime.sendMessage({type:'DIAGNOSTIC', message, url:location.href}).catch(()=>{});
    console.info('[AWS Session FIFO]', message);
  };
  function onLimitPage() {
    return /\/sessions\/limit\/?(?:\?|$)/.test(location.pathname + location.search) ||
      (norm(document.body?.innerText).includes('session limit reached') && norm(document.body?.innerText).includes('current sessions'));
  }
  function ageMinutes(text) {
    const s = norm(text);
    const m = s.match(/logged in\s+(\d+)\s+(second|minute|hour|day|week)s?\s+ago/);
    if (!m) return null;
    return +m[1] * {second:1/60,minute:1,hour:60,day:1440,week:10080}[m[2]];
  }
  function options() {
    const radios = [...document.querySelectorAll('input[type="radio"], [role="radio"]')];
    const result = [];
    for (const radio of radios) {
      let container = radio.parentElement;
      while (container && container !== document.body) {
        const age = ageMinutes(container.innerText || container.textContent || '');
        if (age !== null) {
          if (container.querySelectorAll('input[type="radio"], [role="radio"]').length === 1) result.push({radio, container, age});
          break;
        }
        container = container.parentElement;
      }
    }
    return {result, radioCount:radios.length};
  }
  function button() {
    // AWS's 2026 console uses an <a>, not a <button>, for this action.
    return document.querySelector('[data-testid="sessions-limit-signout-and-continue"]') ||
      [...document.querySelectorAll('button,a,[role="button"],input[type="submit"]')].find(el =>
        norm(el.innerText || el.textContent || el.value || el.getAttribute('aria-label')).includes('sign out selected session and continue'));
  }
  function isDisabled(el) {
    return el.disabled === true || el.getAttribute('aria-disabled') === 'true' ||
      el.hasAttribute('disabled');
  }
  function selected(el) { return el.checked === true || el.getAttribute('aria-checked') === 'true' || el.getAttribute('data-state') === 'checked'; }
  async function select(row, btn) {
    const {radio, container} = row;
    const targets = [radio, radio.closest('label'), container.querySelector('label'), container].filter(Boolean);
    for (const target of [...new Set(targets)]) {
      target.click();
      await delay(180);
      if (selected(radio) || (!isDisabled(btn))) return true;
    }
    return selected(radio);
  }
  async function run() {
    if (busy || completed || !onLimitPage()) return;
    busy = true;
    try {
      // Always active: no setup step, toggle, or popup dependency.
      const {result,radioCount} = options();
      const btn = button();
      if (result.length !== 5 || !btn) {
        report('Waiting for AWS controls', {radios:radioCount, matchedRows:result.length, buttonFound:!!btn});
        return;
      }
      const oldest = result.reduce((a,b) => b.age > a.age ? b : a);
      report('Selecting oldest', {ageMinutes:oldest.age});
      if (!await select(oldest, btn)) { report('Unable to select AWS radio'); return; }
      await delay(150);
      if (isDisabled(btn)) { report('Continue button still disabled'); return; }
      const armed = await chrome.runtime.sendMessage({type:'ARM_CLOSE_ON_LOGOUT'});
      if (!armed?.ok) {report(armed?.reason || 'Could not arm safe tab close'); return;}
      report('Clicking AWS continue link; will retry portal launch after confirmed sign-out', {retryAvailable:armed.retryAvailable});
      btn.click();
      completed = true;
    } catch (error) { report('Error: ' + (error?.message || String(error))); }
    finally { busy = false; }
  }
  let timer;
  new MutationObserver(() => {clearTimeout(timer);timer = setTimeout(run, 300);})
    .observe(document.documentElement, {subtree:true,childList:true,attributes:true,attributeFilter:['disabled','aria-checked','checked']});
  run();
})();
