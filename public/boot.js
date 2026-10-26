// Independent of the application bundle, so failed module loads stay recoverable.
(() => {
  let ready = false;
  let failed = false;
  const showFailure = () => {
    if (ready) return;
    failed = true;
    const message = document.getElementById('startup-message');
    const retry = document.getElementById('startup-retry');
    if (message) message.textContent = 'No se ha podido cargar la aplicación. Conéctate a internet y pulsa Reintentar. Tus datos guardados se conservan.';
    if (retry) retry.hidden = false;
  };
  window.addEventListener('boveda:ready', () => { ready = true; });
  window.addEventListener('error', showFailure, true);
  window.addEventListener('unhandledrejection', showFailure);
  document.addEventListener('DOMContentLoaded', () => {
    if (failed) showFailure();
    document.getElementById('startup-retry')?.addEventListener('click', () => window.location.reload());
    window.setTimeout(showFailure, 12000);
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!ready) window.location.reload();
    });
    navigator.serviceWorker.register('/sw.js?v=20261018-complete-shell', { updateViaCache: 'none' })
      .then((registration) => registration.update()).catch(() => {});
  }
})();
