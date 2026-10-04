// Se ejecuta antes de pintar la pagina para evitar el parpadeo de tema.
(function () {
  try {
    var saved = localStorage.getItem('theme');
    var theme = saved === 'light' || saved === 'dark' ? saved : 'light'; // sin eleccion guardada: tema claro (la obra luce mejor sobre papel)
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    /* sin almacenamiento: se usa la preferencia del sistema por CSS */
  }
})();
