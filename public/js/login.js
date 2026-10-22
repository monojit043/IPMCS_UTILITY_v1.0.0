document.getElementById('pwToggle').addEventListener('click', () => {
  const input = document.getElementById('password');
  const icon = document.getElementById('pwIcon');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  icon.className = showing ? 'ti ti-eye' : 'ti ti-eye-off';
});

function showFieldError(inputId, errId) {
  document.getElementById(inputId).classList.add('input-invalid');
  document.getElementById(errId).classList.add('show');
}
function clearFieldErrors() {
  document.querySelectorAll('.input-invalid').forEach(el => el.classList.remove('input-invalid'));
  document.querySelectorAll('.field-error.show').forEach(el => el.classList.remove('show'));
}

function setLoading(on) {
  document.getElementById('spinner').style.display = on ? 'block' : 'none';
  document.getElementById('btnIcon').style.display = on ? 'none' : 'block';
  document.getElementById('btnText').textContent = on ? 'Authenticating…' : 'Access Workspace';
  document.querySelector('.btn-submit').disabled = on;
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearFieldErrors();

  const empId = document.getElementById('empId').value.trim();
  const password = document.getElementById('password').value;
  let valid = true;
  if (!empId) { showFieldError('empId', 'empIdErr'); valid = false; }
  if (!password) { showFieldError('password', 'pwErr'); valid = false; }
  if (!valid) return;

  setLoading(true);
  try {
    // Credentials are checked here; if the employee has more than one
    // job/unit assignment, workspace.html itself prompts for which to use
    // (see DataStore.getPendingAssignment in workspace.js) instead of doing
    // it on top of the login screen.
    await DataStore.login(empId, password);
    window.location.href = 'workspace.html';
  } catch (err) {
    setLoading(false);
    showToast('error', 'Login failed', err.message);
  }
});

let toastTimer;
function showToast(type, title, sub) {
  const icons = { success: 'ti-check-circle', error: 'ti-alert-circle', info: 'ti-info-circle' };
  const colors = { success: 'var(--color-success)', error: 'var(--color-danger)', info: 'var(--color-accent-strong)' };
  document.getElementById('toastTitle').textContent = title;
  document.getElementById('toastSub').textContent = sub || '';
  document.getElementById('toastIcon').innerHTML = `<i class="ti ${icons[type]}" style="color:${colors[type]}"></i>`;
  const el = document.getElementById('toast');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
