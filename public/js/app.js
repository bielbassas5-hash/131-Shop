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

  // Ficha de producto: el precio mostrado (y el de la barra inferior) sigue al formato elegido,
  // y la comparacion de tamaños resalta el seleccionado
  var priceEl = document.getElementById('product-price');
  var stickyPrice = document.querySelector('[data-sticky-price]');
  var sizeItems = document.querySelectorAll('[data-size-variant]');
  var variantRadios = document.querySelectorAll('input[name="variant"][data-price-label]');
  if (priceEl && variantRadios.length) {
    variantRadios.forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        priceEl.textContent = r.getAttribute('data-price-label');
        if (stickyPrice) stickyPrice.textContent = r.getAttribute('data-price-label');
        sizeItems.forEach(function (g) {
          g.classList.toggle('active', g.getAttribute('data-size-variant') === r.value);
        });
      });
    });
  }

  // Barra inferior con precio y "Comprar" (solo movil): aparece cuando la caja de compra no se ve
  var stickyBar = document.querySelector('[data-sticky-buy]');
  var buyBox = document.getElementById('comprar');
  if (stickyBar && buyBox && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      stickyBar.hidden = entries[0].isIntersecting;
    }).observe(buyBox);
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
  var thumbs = document.querySelectorAll('[data-gallery-src]');
  var mainImg = document.getElementById('main-image');
  // Pasa a la imagen anterior (-1) o siguiente (1) de la galeria
  function stepGallery(d) {
    if (thumbs.length < 2) return;
    var i = 0;
    thumbs.forEach(function (t, idx) { if (t.classList.contains('active')) i = idx; });
    thumbs[(i + d + thumbs.length) % thumbs.length].click();
  }
  // Gesto de deslizar: izquierda = siguiente, derecha = anterior
  function onSwipe(el, cb) {
    var startX = null;
    el.addEventListener('touchstart', function (e) { startX = e.touches[0].clientX; }, { passive: true });
    el.addEventListener('touchend', function (e) {
      if (startX === null) return;
      var dx = e.changedTouches[0].clientX - startX;
      startX = null;
      if (Math.abs(dx) >= 50) cb(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  if (lightbox && zoomBtn && typeof lightbox.showModal === 'function') {
    var lbImg = lightbox.querySelector('img');
    zoomBtn.addEventListener('click', function () {
      lbImg.src = zoomBtn.getAttribute('data-full');
      lightbox.showModal();
    });
    lightbox.addEventListener('click', function (e) {
      var nav = e.target.closest && e.target.closest('[data-lb-step]');
      if (nav) {
        stepGallery(parseInt(nav.getAttribute('data-lb-step'), 10));
        lbImg.src = zoomBtn.getAttribute('data-full');
        return;
      }
      lightbox.close(); // clic en cualquier otra parte cierra
    });
    lightbox.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      stepGallery(e.key === 'ArrowLeft' ? -1 : 1);
      lbImg.src = zoomBtn.getAttribute('data-full');
    });
    onSwipe(lightbox, function (d) {
      stepGallery(d);
      lbImg.src = zoomBtn.getAttribute('data-full');
    });
  }

  // Galeria de la ficha de producto: cambia la imagen principal sin recargar (miniaturas y deslizar)
  var galleryEl = document.querySelector('.product-gallery');
  if (galleryEl && thumbs.length > 1) onSwipe(galleryEl, stepGallery);
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

  // Formulario de producto: calidad de cada formato segun la resolucion de la imagen
  var formatsBox = document.querySelector('[data-formats]');
  var wInput = document.getElementById('source_width');
  var hInput = document.getElementById('source_height');
  var LEVEL_LABELS = { optima: 'Calidad óptima', aceptable: 'Calidad aceptable', baja: 'Resolución baja' };
  function refreshQuality(autoCheck) {
    if (!formatsBox || !wInput || !hInput) return;
    var w = parseInt(wInput.value, 10);
    var h = parseInt(hInput.value, 10);
    var typeSel = document.getElementById('type');
    var wantedGroup = typeSel && typeSel.value === 'sticker' ? 'sticker' : 'print';
    var hint = formatsBox.querySelector('[data-dims-hint]');
    if (hint) hint.textContent = w > 0 && h > 0 ? 'Resolución de la imagen: ' + w + ' × ' + h + ' px.' : 'Al elegir la imagen verás qué formatos permite con buena calidad.';
    formatsBox.querySelectorAll('.format-row').forEach(function (row) {
      var q = row.querySelector('[data-quality]');
      if (!(w > 0 && h > 0)) {
        q.textContent = '';
        q.className = 'quality';
        return;
      }
      var shortMm = parseFloat(row.getAttribute('data-short-mm'));
      var longMm = parseFloat(row.getAttribute('data-long-mm'));
      var ppp = Math.floor(Math.min(Math.min(w, h) / (shortMm / 25.4), Math.max(w, h) / (longMm / 25.4)));
      var level = ppp >= 300 ? 'optima' : ppp >= 200 ? 'aceptable' : 'baja';
      q.textContent = LEVEL_LABELS[level] + ' (' + ppp + ' ppp)';
      q.className = 'quality q-' + level;
      // En un producto nuevo se proponen solo los formatos con calidad optima
      // (solo los del grupo del tipo elegido: laminas para prints y dibujos, medidas pequeñas para stickers)
      if (autoCheck) row.querySelector('input[type="checkbox"]').checked = level === 'optima' && row.getAttribute('data-group') === wantedGroup;
    });
  }
  var typeInput = document.getElementById('type');
  if (typeInput && formatsBox && formatsBox.hasAttribute('data-autocheck')) {
    typeInput.addEventListener('change', function () { refreshQuality(true); });
  }
  if (wInput && hInput) {
    wInput.addEventListener('input', function () { refreshQuality(false); });
    hInput.addEventListener('input', function () { refreshQuality(false); });
  }

  // Vista previa de la imagen en el formulario de producto
  var fileInput = document.querySelector('input[type="file"][data-preview]');
  if (fileInput) {
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      var img = document.getElementById('image-preview');
      if (!file || !img) return;
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        img.hidden = true; // un PDF no se puede previsualizar como imagen: se convierte al guardar
        return;
      }
      img.src = URL.createObjectURL(file);
      img.hidden = false;
      // Tamaño en pixeles del archivo elegido -> calidad de cada formato
      if (wInput && hInput) {
        var probe = new Image();
        probe.onload = function () {
          wInput.value = probe.naturalWidth;
          hInput.value = probe.naturalHeight;
          refreshQuality(formatsBox && formatsBox.hasAttribute('data-autocheck'));
        };
        probe.src = img.src;
      }
    });
  }
})();
