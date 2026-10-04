// Se ejecuta antes de pintar la pagina para evitar el parpadeo de tema.
(function () {
  try {
    var saved = localStorage.getItem('theme');
    var theme = saved === 'light' || saved === 'dark' ? saved : window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    /* sin almacenamiento: se usa la preferencia del sistema por CSS */
  }
})();
