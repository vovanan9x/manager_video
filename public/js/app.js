// Global frontend JavaScript

// ============ TOAST NOTIFICATION ============
function showToast(message, duration = 2500) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => toast.classList.remove('show'), duration);
}

// ============ SIDEBAR TOGGLE ============
document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('sidebarToggle');
    const sidebar = document.getElementById('sidebar');
    if (toggle && sidebar) {
        const collapsed = localStorage.getItem('sidebar_collapsed') === 'true';
        if (collapsed) sidebar.style.width = '60px';

        toggle.addEventListener('click', () => {
            const isCollapsed = sidebar.style.width === '60px';
            sidebar.style.width = isCollapsed ? '240px' : '60px';
            localStorage.setItem('sidebar_collapsed', !isCollapsed);
        });
    }

    // Flash alerts auto-hide
    document.querySelectorAll('.alert').forEach(el => {
        setTimeout(() => {
            el.style.transition = 'opacity 0.5s';
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 500);
        }, 4000);
    });

    // URL param alerts to toast
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('success') === 'updated') showToast('✅ Cập nhật thành công!');
    if (urlParams.get('success') === 'deleted') showToast('🗑️ Đã xóa thành công!');
    if (urlParams.get('success') === 'added') showToast('✅ Đã thêm thành công!');
    if (urlParams.get('error') === 'self') showToast('⚠️ Không thể xóa tài khoản của chính mình!');
    if (urlParams.get('error') === 'notempty') showToast('⚠️ Thư mục không rỗng, không thể xóa!');
    if (urlParams.get('error') === 'hasvideos') showToast('⚠️ Server còn video, không thể xóa!');
});
