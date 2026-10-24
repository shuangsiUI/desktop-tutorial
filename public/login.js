const form = document.getElementById('loginForm'),
  error = document.getElementById('loginError');
fetch('/api/auth/status', { cache: 'no-store' })
  .then((r) => r.json())
  .then((s) => {
    document.getElementById('setupNotice').hidden = !s.setupRequired;
  })
  .catch(() => {});
form.onsubmit = async (e) => {
  e.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  error.textContent = '';
  try {
    const fd = new FormData(form),
      r = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: fd.get('username'),
          password: fd.get('password'),
          otp: fd.get('otp') || undefined
        })
      }),
      body = await r.json();
    if (!r.ok) throw Error(body.error || '登录失败');
    form.reset();
    location.replace(body.user.role === 'customer' ? '/tms/wos/shipment' : '/admin');
  } catch (e) {
    error.textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
