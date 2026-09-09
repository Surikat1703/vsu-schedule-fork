const { contextBridge } = require('electron');

// Подставляем базовый адрес API сервиса для локального фронтенда.
contextBridge.exposeInMainWorld('__API_BASE__', 'https://vsu.my1gvps.xyz');