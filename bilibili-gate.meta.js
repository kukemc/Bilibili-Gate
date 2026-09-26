// ==UserScript==
// @name         Bilibili-Gate 弹幕预览版
// @namespace    https://github.com/kukemc/Bilibili-Gate
// @version      0.35.9
// @author       magicdawn; kukemc (danmaku fork)
// @description  Bilibili 自定义首页
// @license      MIT
// @icon         https://www.bilibili.com/favicon.ico
// @homepageURL  https://github.com/kukemc/Bilibili-Gate
// @supportURL   https://github.com/kukemc/Bilibili-Gate/issues
// @downloadURL  https://raw.githubusercontent.com/kukemc/Bilibili-Gate/refs/heads/release-danmaku/bilibili-gate.user.js
// @updateURL    https://raw.githubusercontent.com/kukemc/Bilibili-Gate/refs/heads/release-danmaku/bilibili-gate.meta.js
// @match        https://www.bilibili.com/
// @match        https://www.bilibili.com/?*
// @match        https://www.bilibili.com/index.html
// @match        https://www.bilibili.com/index.html?*
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/watchlater?*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://space.bilibili.com/*
// @match        https://search.bilibili.com/*
// @require      https://registry.npmmirror.com/axios/1.20.0/files/dist/axios.min.js
// @require      https://registry.npmmirror.com/ua-parser-js/1.0.41/files/dist/ua-parser.min.js
// @require      https://registry.npmmirror.com/localforage/1.10.0/files/dist/localforage.min.js
// @require      https://registry.npmmirror.com/pinyin-match/1.2.10/files/dist/main.js
// @require      https://registry.npmmirror.com/spark-md5/3.0.2/files/spark-md5.min.js
// @tag          bilibili
// @connect      app.bilibili.com
// @grant        GM.deleteValue
// @grant        GM.getValue
// @grant        GM.listValues
// @grant        GM.openInTab
// @grant        GM.registerMenuCommand
// @grant        GM.setClipboard
// @grant        GM.setValue
// @grant        GM.xmlHttpRequest
// @grant        GM_addStyle
// @grant        GM_addValueChangeListener
// @grant        GM_info
// @grant        unsafeWindow
// @run-at       document-body
// ==/UserScript==