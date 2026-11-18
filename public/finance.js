// OpenVibe.Finance: a chosen CSV, OFX or QFX file goes into the paste box; a PDF statement is read as data for the server
// to read (the form posts it to /accounts/:id/statement, which shows what it found before anything is imported).
(function () {
    document.addEventListener('change', function (e) {
        var input = e.target;
        if (!input || !input.matches || !input.matches('input[data-fin-file="csv"]') || !input.files || !input.files[0]) return;
        var file = input.files[0];
        var form = input.closest('form');
        input.setCustomValidity('');
        var isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
        var limit = isPdf ? 6 : 4;
        if (file.size > limit * 1024 * 1024) { input.setCustomValidity('That file is over ' + limit + ' MB. Export fewer months at a time.'); input.reportValidity(); input.value = ''; return; }
        var box = form && form.querySelector('textarea[data-fin-csv]');
        var pdf = form && form.querySelector('[data-fin-pdf]');
        var named = input.closest('label') && input.closest('label').querySelector('[data-fin-file-name]');
        if (named) named.textContent = file.name;
        var reader = new FileReader();
        if (isPdf && pdf && form.getAttribute('data-fin-statement')) {
            if (!form.getAttribute('data-fin-import')) form.setAttribute('data-fin-import', form.getAttribute('action'));
            form.setAttribute('action', form.getAttribute('data-fin-statement'));
            if (box) { box.required = false; box.value = ''; }
            var nm = form.querySelector('[data-fin-pdf-name]'); if (nm) nm.value = file.name;
            reader.onload = function () { pdf.value = String(reader.result || ''); };
            reader.readAsDataURL(file);
            return;
        }
        if (form && form.getAttribute('data-fin-import')) form.setAttribute('action', form.getAttribute('data-fin-import'));
        if (pdf) pdf.value = '';
        if (box) box.required = true;
        if (!box) return;
        reader.onload = function () { box.value = String(reader.result || ''); };
        reader.readAsText(file);
    });
})();

// A receipt photo (v0.12): redrawn at most 2000 px (enough to read, and the camera's own data is not carried over), then
// sent once for this server to read; nothing is added before the person checks it.
(function () {
    document.addEventListener('change', function (e) {
        var input = e.target;
        if (!input || !input.matches || !input.matches('input[data-fin-receipt]') || !input.files || !input.files[0]) return;
        var form = input.closest('form');
        var out = form && form.querySelector('[data-fin-image]');
        var said = form && form.querySelector('[data-fin-receipt-said]');
        var file = input.files[0];
        if (!out || !/^image\//.test(file.type)) { if (said) said.textContent = 'That is not a photo.'; return; }
        if (said) said.textContent = 'Reading the receipt…';
        form.classList.add('is-busy');
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
            var scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
            var c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(img.naturalWidth * scale));
            c.height = Math.max(1, Math.round(img.naturalHeight * scale));
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            URL.revokeObjectURL(url);
            out.value = c.toDataURL('image/jpeg', 0.92);
            form.submit();
        };
        img.onerror = function () { URL.revokeObjectURL(url); form.classList.remove('is-busy'); if (said) said.textContent = 'That photo could not be opened.'; };
        img.src = url;
    });
})();
