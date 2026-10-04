(function () {
  'use strict';

  // Confirmacion antes de acciones destructivas: <form data-confirm="...">
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var msg = form.getAttribute && form.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) {
      e.preventDefault();
      return;
    }
    // Evita dobles envios (pedidos duplicados): <form data-once>
    if (form.hasAttribute && form.hasAttribute('data-once')) {
      var btn = form.querySelector('button[type="submit"]');
      if (btn) {
        setTimeout(function () {
          btn.disabled = true;
          btn.textContent = 'Procesando...';
        }, 0);
      }
    }
  });

  // Envio automatico al cambiar un selector: <select data-autosubmit>
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.hasAttribute && el.hasAttribute('data-autosubmit') && el.form) {
      if (el.form.requestSubmit) el.form.requestSubmit();
      else el.form.submit();
    }
  });

  // Cerrar avisos
  document.addEventListener('click', function (e) {
    var close = e.target.closest && e.target.closest('[data-dismiss]');
    if (close) {
      var box = close.closest('.flash');
      if (box) box.remove();
    }

    // Copiar al portapapeles: <button data-copy="texto">
    var copy = e.target.closest && e.target.closest('[data-copy]');
    if (copy && navigator.clipboard) {
      navigator.clipboard.writeText(copy.getAttribute('data-copy')).then(function () {
        var old = copy.textContent;
        copy.textContent = 'Copiado';
        setTimeout(function () {
          copy.textContent = old;
        }, 1500);
      });
    }
  });

  // Checkout: alternar envio / recogida y recalcular el resumen
  var radios = document.querySelectorAll('input[name="method"][data-ship-cents]');
  var summary = document.querySelector('[data-summary]');
  if (radios.length && summary) {
    var fmt = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
    var shipFields = document.querySelector('[data-ship-fields]');
    var update = function () {
      var sel = document.querySelector('input[name="method"]:checked');
      if (!sel) return;
      var ship = parseInt(sel.getAttribute('data-ship-cents'), 10) || 0;
      var subtotal = parseInt(summary.getAttribute('data-subtotal'), 10) || 0;
      var shipOut = summary.querySelector('[data-ship-out]');
      var totalOut = summary.querySelector('[data-total-out]');
      if (shipOut) shipOut.textContent = ship ? fmt.format(ship / 100) : 'Gratis';
      if (totalOut) totalOut.textContent = fmt.format((subtotal + ship) / 100);
      if (shipFields) shipFields.hidden = sel.value === 'pickup';
    };
    radios.forEach(function (r) { r.addEventListener('change', update); });
    update();
  }

  // Cambio de tema claro / oscuro (se recuerda en este navegador)
  var themeBtn = document.querySelector('[data-theme-toggle]');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var root = document.documentElement;
      var current = root.getAttribute('data-theme') || 'light';
      var next = current === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) { /* ignorado */ }
    });
  }

  // Imagen ampliada (ficha de producto)
  var lightbox = document.getElementById('lightbox');
  var zoomBtn = document.querySelector('[data-lightbox]');
  if (lightbox && zoomBtn && typeof lightbox.showModal === 'function') {
    var lbImg = lightbox.querySelector('img');
    zoomBtn.addEventListener('click', function () {
      lbImg.src = zoomBtn.getAttribute('data-full');
      lightbox.showModal();
    });
    lightbox.addEventListener('click', function () { lightbox.close(); }); // clic en cualquier parte cierra
  }

  // Galeria de la ficha de producto: cambia la imagen principal sin recargar
  var thumbs = document.querySelectorAll('[data-gallery-src]');
  var mainImg = document.getElementById('main-image');
  if (thumbs.length && mainImg) {
    thumbs.forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        mainImg.src = a.getAttribute('data-gallery-src');
        if (zoomBtn) zoomBtn.setAttribute('data-full', a.getAttribute('data-gallery-full') || a.getAttribute('data-gallery-src'));
        thumbs.forEach(function (t) { t.classList.remove('active'); });
        a.classList.add('active');
      });
    });
  }

  // Vista previa de la imagen en el formulario de producto
  var fileInput = document.querySelector('input[type="file"][data-preview]');
  if (fileInput) {
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      var img = document.getElementById('image-preview');
      if (!file || !img) return;
      img.src = URL.createObjectURL(file);
      img.hidden = false;
    });
  }
})();
