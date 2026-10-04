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
