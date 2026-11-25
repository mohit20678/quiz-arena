'use strict';

const tabAdmin = document.getElementById('tabAdmin');
const tabStudent = document.getElementById('tabStudent');
const panelAdmin = document.getElementById('panelAdmin');
const panelStudent = document.getElementById('panelStudent');

function selectTab(which) {
  const admin = which === 'admin';
  tabAdmin.classList.toggle('active', admin);
  tabStudent.classList.toggle('active', !admin);
  tabAdmin.setAttribute('aria-selected', String(admin));
  tabStudent.setAttribute('aria-selected', String(!admin));
  panelAdmin.classList.toggle('active', admin);
  panelStudent.classList.toggle('active', !admin);
}

tabAdmin.addEventListener('click', () => selectTab('admin'));
tabStudent.addEventListener('click', () => selectTab('student'));
