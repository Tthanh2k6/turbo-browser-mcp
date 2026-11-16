// Observation only: this cannot undo a request or establish submission success.
export function observeClickAftermath(page) {
  const beforeUrl = page.url();
  const mutatingRequests = [];
  let navigated = false;
  const pathChanged = (url) => {
    try {
      const before = new URL(beforeUrl), after = new URL(url);
      return before.origin !== after.origin || before.pathname !== after.pathname;
    } catch { return url !== beforeUrl; }
  };
  const onNavigation = (frame) => {
    if (frame === page.mainFrame() && pathChanged(frame.url())) navigated = true;
  };
  const onRequest = (request) => {
    const method = request.method();
    if (!/^(POST|PUT|PATCH|DELETE)$/.test(method) || !['fetch', 'xhr'].includes(request.resourceType())) return;
    const url = request.url();
    let pathname = '';
    try { pathname = new URL(url).pathname; } catch {}
    const finalSubmit = method === 'DELETE' ||
      /(?:^|[/_.-])(?:submit|publish|commit|checkout|payment|purchase|delete)(?:$|[/_.-])/i.test(pathname);
    mutatingRequests.push({ method, url, finalSubmit });
  };
  page.on('request', onRequest);
  page.on('framenavigated', onNavigation);
  return {
    async finish(result, allowSubmit) {
      if (!result || result.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const unexpectedSubmit = !allowSubmit && (navigated || mutatingRequests.some((r) => r.finalSubmit));
      result.aftermath = { beforeUrl, afterUrl: page.url(), navigated, mutatingRequests, unexpectedSubmit };
      if (unexpectedSubmit) {
        result.aftermath.warning = 'Possible final submit observed despite allowSubmit=false. The action already occurred; inspect the result before retrying.';
      }
    },
    remove() {
      page.off('request', onRequest);
      page.off('framenavigated', onNavigation);
    },
  };
}
