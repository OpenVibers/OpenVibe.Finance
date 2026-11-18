// OpenVibe.Finance: a chosen CSV file goes into the paste box (the form posts the text; nothing leaves before Import).
(function () {
    document.addEventListener('change', function (e) {
        var input = e.target;
        if (!input || !input.matches || !input.matches('input[data-fin-file="csv"]') || !input.files || !input.files[0]) return;
        var file = input.files[0];
        input.setCustomValidity('');
        if (file.size > 4 * 1024 * 1024) { input.setCustomValidity('That file is over 4 MB. Export fewer months at a time.'); input.reportValidity(); input.value = ''; return; }
        var box = input.closest('form') && input.closest('form').querySelector('textarea[data-fin-csv]');
        if (!box) return;
        var reader = new FileReader();
        var named = input.closest('label') && input.closest('label').querySelector('[data-fin-file-name]');
        if (named) named.textContent = file.name;
        reader.onload = function () { box.value = String(reader.result || ''); };
        reader.readAsText(file);
    });
})();
