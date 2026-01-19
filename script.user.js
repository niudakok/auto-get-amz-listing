// ==UserScript==
// @name         亚马逊竞品采集
// @namespace    http://tampermonkey.net/
// @version      0.4.4
// @description  采集亚马逊商品页面信息并同步到飞书多维表格，支持配置页面、双方案选择、自动创建字段、A+截图
// @author       niuda123
// @match        *://*.amazon.com/*
// @match        *://*.amazon.co.uk/*
// @match        *://*.amazon.de/*
// @match        *://*.amazon.fr/*
// @match        *://*.amazon.it/*
// @match        *://*.amazon.es/*
// @match        *://*.amazon.co.jp/*
// @match        *://*.amazon.ca/*
// @match        *://*.amazon.com.au/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_download
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @connect      open.feishu.cn
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    // ==================== 判断是否为商品页 ====================

    function isProductPage() {
        // 支持多种URL格式:
        // /dp/ASIN
        // /gp/product/ASIN
        // /*/dp/ASIN (带产品名称)
        // 带各种参数的URL
        return /\/dp\/[A-Z0-9]{10}|\/gp\/product\/[A-Z0-9]{10}/i.test(window.location.href);
    }

    // 如果不是商品页，直接返回
    if (!isProductPage()) {
        return;
    }

    // ==================== 配置管理 ====================

    const CONFIG_KEY = 'amazon_collector_config';

    // 默认配置
    const defaultConfig = {
        // 方案选择: 'feishu' | 'localapi'
        方案: 'feishu',

        // 飞书配置
        飞书: {
            appId: '',
            appSecret: '',
            表格链接: '',
            // 以下由表格链接解析
            appToken: '',
            tableId: ''
        },

        // 本地API配置
        本地API: {
            地址: 'http://localhost:8000',
            端点: '/api/v1/competitor/add'
        }
    };

    // 获取配置
    function getConfig() {
        const saved = GM_getValue(CONFIG_KEY);
        if (saved) {
            try {
                return { ...defaultConfig, ...JSON.parse(saved) };
            } catch (e) {
                console.error('配置解析失败', e);
            }
        }
        return defaultConfig;
    }

    // 保存配置
    function saveConfig(config) {
        GM_setValue(CONFIG_KEY, JSON.stringify(config));
    }

    // 解析飞书表格链接
    function parseFeishuUrl(url) {
        // 示例链接: https://xxx.feishu.cn/base/xxxAppToken?table=xxxTableId
        const result = { appToken: '', tableId: '' };

        try {
            const urlObj = new URL(url);
            const pathParts = urlObj.pathname.split('/');

            // 多维表格链接格式
            if (url.includes('/base/')) {
                const baseIndex = pathParts.indexOf('base');
                if (baseIndex !== -1 && pathParts[baseIndex + 1]) {
                    result.appToken = pathParts[baseIndex + 1].split('?')[0];
                }

                // 从URL参数获取tableId
                const tableParam = urlObj.searchParams.get('table');
                if (tableParam) {
                    result.tableId = tableParam;
                }
            }
        } catch (e) {
            console.error('解析飞书链接失败', e);
        }

        return result;
    }

    // ==================== 市场代码识别 ====================

    function getMarketCode() {
        const host = window.location.hostname;
        const marketMap = {
            'www.amazon.com': 'US',
            'www.amazon.co.uk': 'UK',
            'www.amazon.de': 'DE',
            'www.amazon.fr': 'FR',
            'www.amazon.it': 'IT',
            'www.amazon.es': 'ES',
            'www.amazon.co.jp': 'JP',
            'www.amazon.ca': 'CA',
            'www.amazon.com.au': 'AU'
        };
        return marketMap[host] || 'US';
    }

    // ==================== 数据提取函数 ====================

    // 获取ASIN
    function getASIN() {
        // 从URL获取 - 支持各种格式
        const urlMatch = window.location.href.match(/\/dp\/([A-Z0-9]{10})|\/gp\/product\/([A-Z0-9]{10})/i);
        if (urlMatch) {
            return (urlMatch[1] || urlMatch[2]).toUpperCase();
        }
        // 从页面元素获取
        const asinElement = document.querySelector('[data-asin]');
        if (asinElement) {
            return asinElement.getAttribute('data-asin');
        }
        return '';
    }

    // 获取商品标题
    function getTitle() {
        const el = document.getElementById('productTitle');
        return el ? el.innerText.trim() : '';
    }

    // 获取品牌 - 使用精确选择器
    function getBrand() {
        // 方式1: bylineInfo - 清理各种前缀
        const byline = document.getElementById('bylineInfo');
        if (byline) {
            let brand = byline.innerText.trim();
            // 清理各种语言的前缀
            brand = brand.replace(/^(Visit the |Brand: |Store: |Visita lo Store di |Marque\s*:\s*|Marke\s*:\s*|Marca\s*:\s*|ブランド\s*:\s*)/i, '');
            brand = brand.replace(/\s+Store$/i, ''); // 移除结尾的 Store
            if (brand) return brand.trim();
        }

        // 方式3: 产品详情表格按标签查找
        const detailsTable = document.getElementById('productDetails_detailBullets_sections1');
        if (detailsTable) {
            const rows = detailsTable.querySelectorAll('tr');
            for (const row of rows) {
                const header = row.querySelector('th');
                if (header && /brand|marca|marque|marke|メーカー/i.test(header.innerText)) {
                    const value = row.querySelector('td');
                    if (value) return value.innerText.trim();
                }
            }
        }

        return '';
    }




    // 获取五点描述 - 使用精确选择器，支持最多6条
    function getBulletPoints() {
        const bullets = [];

        // 使用精确选择器逐条获取
        for (let i = 1; i <= 6; i++) {
            const el = document.querySelector(`#feature-bullets > ul > li:nth-child(${i})`);
            if (el) {
                const text = el.innerText.trim();
                // 过滤掉导航链接和过短内容
                if (text && !text.includes('›') && text.length > 5) {
                    bullets.push(text);
                }
            }
        }

        // 备用方式：使用通用选择器
        if (bullets.length === 0) {
            const elements = document.querySelectorAll('#feature-bullets .a-list-item');
            elements.forEach(el => {
                const text = el.innerText.trim();
                if (text && !text.includes('›') && text.length > 10) {
                    bullets.push(text);
                }
            });
        }

        return bullets;
    }

    // 获取产品描述 - 优先获取A+内容
    function getDescription() {
        // 方式1: A+页面内容
        const aplusContent = document.querySelector('#aplus > div > div');
        if (aplusContent && aplusContent.innerText.trim()) {
            return aplusContent.innerText.trim();
        }

        // 方式2: 传统产品描述
        const el = document.getElementById('productDescription');
        if (el) {
            const p = el.querySelector('p');
            return p ? p.innerText.trim() : el.innerText.trim();
        }

        return '';
    }

    // A+页面截图
    async function captureAplus() {
        const aplus = document.querySelector('#aplus > div > div');
        if (!aplus) {
            alert('❌ 未找到A+页面区域 (#aplus > div > div)');
            return;
        }

        const asin = getASIN();
        const btn = document.getElementById('btn-capture-aplus');
        const originalText = btn.textContent;
        btn.textContent = '⏱️ 准备中...';
        btn.disabled = true;

        // 使用setTimeout让UI有机会更新，避免直接卡死
        setTimeout(async () => {
            try {
                btn.textContent = '📸 正在绘图(页面可能会卡顿几秒)...';

                const canvas = await html2canvas(aplus, {
                    useCORS: true,
                    allowTaint: true,
                    backgroundColor: '#ffffff',
                    scale: 1.5, // 降低分辨率以提高速度 (默认是设备像素比，通常是2或3)
                    logging: false // 关闭日志
                });

                const dataUrl = canvas.toDataURL('image/png');
                const filename = `${asin}_Aplus.png`;

                btn.textContent = '💾 正在保存...';

                // 使用GM_download下载
                GM_download({
                    url: dataUrl,
                    name: filename,
                    onload: () => {
                        btn.textContent = '✅ 保存成功';
                        setTimeout(() => {
                            btn.textContent = originalText;
                            btn.disabled = false;
                        }, 2000);
                    },
                    onerror: (e) => {
                        console.error('Download failed:', e);
                        alert('❌ 下载失败，请检查浏览器权限');
                        btn.textContent = originalText;
                        btn.disabled = false;
                    }
                });

            } catch (e) {
                console.error('Screenshot failed:', e);
                alert('❌ 截图失败: ' + e.message);
                btn.textContent = originalText;
                btn.disabled = false;
            }
        }, 100);
    }


    // 获取图片信息 - 修复：正确获取所有图片URL
    function getImages() {
        const result = {
            主图: '',
            副图1: '', 副图2: '', 副图3: '', 副图4: '',
            副图5: '', 副图6: '', 副图7: '', 副图8: ''
        };

        // 方式1: 从图片数据脚本获取
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            const content = script.textContent || '';
            if (content.includes('ImageBlockATF') || content.includes('colorImages')) {
                // 提取图片URL
                const matches = content.matchAll(/"hiRes"\s*:\s*"([^"]+)"/g);
                let index = 0;
                for (const match of matches) {
                    if (match[1] && match[1].startsWith('http')) {
                        if (index === 0) {
                            result.主图 = match[1];
                        } else if (index <= 8) {
                            result[`副图${index}`] = match[1];
                        }
                        index++;
                    }
                }
                if (result.主图) break;

                // 备用：提取large图片
                const largeMatches = content.matchAll(/"large"\s*:\s*"([^"]+)"/g);
                index = 0;
                for (const match of largeMatches) {
                    if (match[1] && match[1].startsWith('http')) {
                        if (index === 0) {
                            result.主图 = match[1];
                        } else if (index <= 8) {
                            result[`副图${index}`] = match[1];
                        }
                        index++;
                    }
                }
                if (result.主图) break;
            }
        }

        // 方式2: 从页面元素获取
        if (!result.主图) {
            const mainImg = document.getElementById('landingImage') || document.querySelector('#imgTagWrapperId img');
            if (mainImg) {
                result.主图 = mainImg.getAttribute('data-old-hires') ||
                    mainImg.getAttribute('data-a-dynamic-image')?.match(/"([^"]+)"/)?.[1] ||
                    mainImg.src;
            }
        }

        // 方式3: 从缩略图获取副图
        if (!result.副图1) {
            const thumbs = document.querySelectorAll('#altImages .imageThumbnail img, #altImages .a-button-thumbnail img');
            let index = 1;
            thumbs.forEach(img => {
                if (index <= 8) {
                    // 转换缩略图URL为大图URL
                    let url = img.src || '';
                    // 移除尺寸限制参数
                    url = url.replace(/\._[A-Z]+\d+_\./, '.');
                    url = url.replace(/\._S[XY]\d+_\./, '.');
                    if (url && !url.includes('play-button') && !url.includes('video')) {
                        result[`副图${index}`] = url;
                        index++;
                    }
                }
            });
        }

        return result;
    }




    // 获取A+页面图片 - 新增
    function getAPlusImages() {
        const images = [];

        // A+模块图片
        const aplusSelectors = [
            '#aplus img',
            '#aplus-media-container img',
            '.apm-hovermodule img',
            '.aplus-v2 img',
            '#productDescription_feature_div img'
        ];

        for (const selector of aplusSelectors) {
            const imgs = document.querySelectorAll(selector);
            imgs.forEach(img => {
                let url = img.getAttribute('data-src') || img.src || '';
                // 获取高清版本
                url = url.replace(/\._[A-Z]+\d+_\./, '.');
                if (url && url.startsWith('http') && !images.includes(url)) {
                    images.push(url);
                }
            });
        }

        return images;
    }

    // 获取销售排名 - 支持大类目和小类目、卖家精灵等插件
    function getBSR() {
        const result = {
            排名: 0,
            类目: '',
            类目链接: '',
            小类目排名: 0,
            小类目: '',
            小类目链接: ''
        };

        // 首先尝试从页面链接获取BSR URL
        const bsrLinks = document.querySelectorAll('a[href*="bestsellers"], a[href*="gp/bestsellers"]');
        const linkMap = new Map(); // 类目名 -> URL
        bsrLinks.forEach(link => {
            const text = link.innerText.trim();
            if (text && link.href) {
                linkMap.set(text, link.href);
            }
        });

        // 方式0: 优先使用精确的DOM选择器获取BSR信息
        // 兼容多个站点的选择器
        const bsrSelectors = [
            '#productDetails_detailBullets_sections1 > tbody > tr:nth-child(3) > td', // 美国站常用
            '#productDetails_db_sections > tbody > tr:nth-child(2) > td', // 英国站常用
            '#productDetails_detailBullets_sections1 > tbody > tr:nth-child(2) > td > span > ul' // 英国站新提供的精确路径
        ];

        let bsrCell = null;
        for (const selector of bsrSelectors) {
            const el = document.querySelector(selector);
            if (el) {
                bsrCell = el;
                break;
            }
        }

        if (bsrCell) {
            const bsrText = bsrCell.innerText || '';
            // 匹配多种BSR格式
            const bsrPatterns = [
                // 带有 "Best Sellers Rank" 前缀 (英国站常见), 允许可选的 # 号
                /(?:Best Sellers Rank|Rank)[:\s]*#?([\d,.]+)\s+(?:in|nella categoria|dans|en)\s+([^\n\(#]+)/gi,
                // 标准格式 #123 in Category
                /#([\d,.]+)\s+(?:in|nella categoria|dans|en)\s+([^\n\(#]+)/gi,
                /n\.\s*([\d,.]+)\s+(?:in|nella categoria)\s+([^\n\(]+?)(?:\s*\(|\s*n\.|\s*$)/gi,
                /Nr\.\s*([\d,.]+)\s+(?:in|en)\s+([^\n\(]+)/gi,
                /([^\n\-]+?)\s*-\s*([\d,]+)位/g
            ];

            let matches = [];
            for (const pattern of bsrPatterns) {
                const found = [...bsrText.matchAll(pattern)];
                if (found.length > 0) {
                    matches = found.map(m => {
                        if (m[0].includes('位')) {
                            return { 排名: parseInt(m[2].replace(/[,.\s]/g, '')), 类目: m[1].trim() };
                        }
                        // 适配 regex group index, 因为有的pattern可能有不同数量的group
                        // 统一逻辑：数字是 group 1, 类目是 group 2 (除了日语)
                        return { 排名: parseInt(m[1].replace(/[,.\s]/g, '')), 类目: m[2].trim() };
                    });
                    break;
                }
            }

            // 按排名从大到小排序
            matches.sort((a, b) => b.排名 - a.排名);

            if (matches.length > 0) {
                result.排名 = matches[0].排名;
                result.类目 = matches[0].类目.replace(/\s*(Visualizza i Top \d+|See Top \d+|Voir le Top \d+|の売れ筋ランキングを見る)\s*/gi, '').trim();

                // 查找对应的URL
                for (const [name, url] of linkMap) {
                    if (result.类目.includes(name) || name.includes(result.类目)) {
                        result.类目链接 = url;
                        break;
                    }
                }

                if (matches.length > 1) {
                    result.小类目排名 = matches[1].排名;
                    result.小类目 = matches[1].类目.replace(/\s*(Visualizza i Top \d+|See Top \d+|Voir le Top \d+|の売れ筋ランキングを見る)\s*/gi, '').trim();

                    for (const [name, url] of linkMap) {
                        if (result.小类目.includes(name) || name.includes(result.小类目)) {
                            result.小类目链接 = url;
                            break;
                        }
                    }
                }

                console.log('BSR采集结果(精确选择器):', result);
                return result;
            }
        }

        // 方式3: 使用XPath全页搜索 "Best Sellers Rank" 文本节点，获取其上下文
        // 这可以解决找不到特定选择器的问题，只要页面上有文字
        let xpathText = '';
        try {
            const xpath = "//*[contains(text(), 'Best Sellers Rank') or contains(text(), 'Best Sellers Rank:') or contains(text(), 'Clasificación en los más vendidos de Amazon') or contains(text(), \"Classement des meilleures ventes d'Amazon\")]";
            const xpathResult = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let i = 0; i < xpathResult.snapshotLength; i++) {
                const node = xpathResult.snapshotItem(i);
                // 收集父元素文本 (通常是 td 或 li)
                if (node.parentElement) {
                    xpathText += node.parentElement.innerText + '\n';
                    // 收集父元素的父元素文本 (防止 label 和 value 分在不同 span 但在同一个 td/tr/li)
                    if (node.parentElement.parentElement) {
                        xpathText += node.parentElement.parentElement.innerText + '\n';
                    }
                    // 收集下一个兄弟元素文本 (例如 label 在 th, value 在 td)
                    if (node.parentElement.nextElementSibling) {
                        xpathText += node.parentElement.nextElementSibling.innerText + '\n';
                    }
                }
            }
        } catch (e) {
            console.warn('XPath搜索BSR失败:', e);
        }

        // 获取整个页面的文本，用于搜索BSR信息，并将XPath找到的文本优先拼接
        const pageText = (xpathText + '\n' + (document.body.innerText || ''));

        // 正则匹配BSR格式，支持多种格式:
        // #252,495 in Category
        // n. 252.495 in Category (意大利语)
        // Nr. 252.495 in Category (德语)
        // ホーム＆キッチン - 1,678位 (日语)
        // 支持多种语言: in(英), nella categoria(意), dans(法), en(西)
        const bsrPatterns = [
            // 格式1: 带有前缀, 允许可选 #, 允许数字中有空格(法/德等千分位)
            /(?:Best Sellers Rank|Rank|Classement des meilleures ventes d'Amazon)[:\s]*#?([\d\s\u00a0\u202f,.]+)\s+(?:in|nella categoria|dans|en)\s+([^\n\(#]+)/gi,
            // 格式2: # 前缀
            /#([\d,.]+)\s+(?:in|nella categoria|dans|en)\s+([^\n#\(]+)/gi,
            // 格式3: n. 前缀 (意大利语) 或 nº 前缀 (西班牙语)
            /(?:n\.|nº)\s*([\d,.]+)\s+(?:in|nella categoria|en)\s+([^\n\(]+)/gi,
            // 格式4: Nr. 前缀 (德语)
            /Nr\.\s*([\d,.]+)\s+(?:in|en)\s+([^\n\(]+)/gi,
            // 格式5: 日语 - 类目名 - 数字位
            /([^\n\-]+?)\s*-\s*([\d,]+)位/g,
            // 格式6: 无前缀纯数字 (常见于小类目/其他变体) -> 123 in Category
            /(?:^|[\n])\s*(?<!\d\s)(?<!\d)([\d\s\u00a0\u202f,.]+)\s+(?:in|nella categoria|dans|en)\s+([^\n\(#]+)/gi
        ];

        let allMatches = [];
        for (const pattern of bsrPatterns) {
            const matches = [...pageText.matchAll(pattern)];
            allMatches = allMatches.concat(matches.map(m => {
                // 日语格式需要交换顺序：类目在前，排名在后
                if (m[0].includes('位')) {
                    return { 排名Text: m[2], 类目Text: m[1] };
                }
                // 统一逻辑：数字是 group 1, 类目是 group 2
                return { 排名Text: m[1], 类目Text: m[2] };
            }));
        }

        // 按排名数字大小排序，大的是大类目，小的是小类目
        const seen = new Set();
        const bsrList = [];

        allMatches.forEach(m => {
            const rank = parseInt((m.排名Text || '').replace(/[,.\s\u00a0\u202f]/g, ''));
            // 清理类目名称，移除 "See Top 100" 等后缀
            let cat = (m.类目Text || '').replace(/\s*(Visualizza i Top \d+|See Top \d+|Voir le Top \d+|の売れ筋ランキングを見る|Ver el Top \d+|Voir les \d+ premiers|in\s+.*)\s*/gi, '').trim();
            // 移除可能的前缀 (in, dans, etc if regex captured it included)
            cat = cat.replace(/^.*\s+(in|nella categoria|dans|en)\s+/i, '');

            if (rank > 0 && cat.length > 0) {
                // 生成唯一键：排名+类目 (忽略大小写)
                const key = `${rank}-${cat.toLowerCase()}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    bsrList.push({ 排名: rank, 类目: cat });
                }
            }
        });

        // 按排名从大到小排序 (数值越大，排名越靠后，通常是大类目)
        // 注意：排名 #1 (数值1) 是最好的。通常大类目排名数值(#10000)比小类目(#50)大。
        bsrList.sort((a, b) => b.排名 - a.排名);

        if (bsrList.length > 0) {
            // 最大排名是大类目
            result.排名 = bsrList[0].排名;
            result.类目 = bsrList[0].类目;
            // 查找对应的URL
            result.类目链接 = findBsrLink(bsrList[0].类目, linkMap);

            // 如果有第二个，且排名不同（或者类目完全不同），则是小类目
            // 再次防止重复
            if (bsrList.length > 1) {
                // 找到第一个类目名不包含"Best Sellers Rank"且不完全相同的小类目
                for (let i = 1; i < bsrList.length; i++) {
                    const sub = bsrList[i];
                    if (sub.类目 !== result.类目) {
                        result.小类目排名 = sub.排名;
                        result.小类目 = sub.类目;
                        result.小类目链接 = findBsrLink(sub.类目, linkMap);
                        break;
                    }
                }
            }
        }

        // 辅助函数：查找类目对应的链接
        function findBsrLink(category, links) {
            // 精确匹配
            if (links.has(category)) return links.get(category);
            // 模糊匹配
            for (const [name, url] of links) {
                if (category.includes(name) || name.includes(category)) {
                    return url;
                }
            }
            return '';
        }

        // 如果上面没找到，尝试从产品详情表格获取
        if (!result.排名) {
            const detailsSelectors = [
                '#productDetails_detailBullets_sections1',
                '#detailBulletsWrapper_feature_div',
                '.prodDetTable',
                '#prodDetails',
                '#detailBullets_feature_div',
                '#productDetails_db_sections' // 英国站
            ];

            for (const selector of detailsSelectors) {
                const el = document.querySelector(selector);
                if (el) {
                    const text = el.innerText;
                    // 尝试匹配BSR
                    for (const pattern of bsrPatterns) {
                        const match = text.match(pattern);
                        if (match) {
                            if (match[0].includes('位')) {
                                result.排名 = parseInt(match[2].replace(/[,.\s]/g, ''));
                                result.类目 = match[1].trim();
                            } else {
                                result.排名 = parseInt(match[1].replace(/[,.\s]/g, ''));
                                result.类目 = match[2].trim();
                            }
                            break;
                        }
                    }
                    if (result.排名) break;
                }
            }
        }

        // 从卖家精灵等插件的特定元素获取
        if (!result.排名) {
            // 卖家精灵通常会在页面顶部插入BSR信息
            const pluginSelectors = [
                '[class*="seller-sprite"]',
                '[class*="sellerSprite"]',
                '[class*="js-bsr"]',
                '[id*="seller-sprite"]',
                '[class*="keepa"]',
                '[class*="junglescout"]'
            ];

            for (const selector of pluginSelectors) {
                const elements = document.querySelectorAll(selector);
                for (const el of elements) {
                    const text = el.innerText || '';
                    const matches = [...text.matchAll(/#([\d,.]+)\s+(?:in|nella categoria|dans|en)\s+([^\n#]+)/gi)];

                    if (matches.length > 0) {
                        const sorted = matches.map(m => ({
                            排名: parseInt(m[1].replace(/[,.]/g, '')),
                            类目: m[2].trim()
                        })).sort((a, b) => b.排名 - a.排名);

                        result.排名 = sorted[0].排名;
                        result.类目 = sorted[0].类目;

                        if (sorted.length > 1) {
                            result.小类目排名 = sorted[1].排名;
                            result.小类目 = sorted[1].类目;
                        }
                        break;
                    }
                }
                if (result.排名) break;
            }
        }

        console.log('BSR采集结果:', result);
        return result;
    }

    // 获取评分信息
    function getRating() {
        const result = {
            评分: 0,
            评论数: 0
        };

        // 评分 - 优先使用正确的选择器
        // 移除宽泛的 .a-icon-star .a-icon-alt，防止误匹配到"5星"筛选器或其他图标
        const ratingSelectors = [
            '#acrPopover > span > a > span', // 用户提供的精确路径
            '#averageCustomerReviews #acrPopover .a-icon-alt', // 标题下方的星星
            '#reviewsMedley .AverageCustomerReviews .a-icon-alt' // 底部评论区的星星
        ];

        for (const selector of ratingSelectors) {
            const ratingEl = document.querySelector(selector);
            if (ratingEl && ratingEl.innerText) {
                // 确保文本包含 "out of 5 stars" 或类似格式，避免匹配到纯数字
                // 但用户提供的选择器直接由数字组成: "4.5"
                const text = ratingEl.innerText.trim();
                const match = text.match(/^([\d,.]+)/); // 只匹配开头的数字
                if (match) {
                    // 处理欧洲格式 4,5 -> 4.5
                    const rating = parseFloat(match[1].replace(',', '.'));
                    // 只有当评分在 0-5 之间才认为是有效的
                    if (!isNaN(rating) && rating >= 0 && rating <= 5) {
                        result.评分 = rating;
                        break;
                    }
                }
            }
        }

        // 评论数
        const reviewCountEl = document.getElementById('acrCustomerReviewText');
        if (reviewCountEl) {
            const match = reviewCountEl.innerText.match(/([\d,.]+)/);
            if (match) {
                result.评论数 = parseInt(match[1].replace(/[,.]/g, ''));
            }
        }

        return result;
    }

    // 获取上架日期
    function getListingDate() {
        const rawKeywords = [
            'Date First Available',
            'Data di prima disponibilità',
            'Disponible sur Amazon.fr depuis',
            'Amazon.co.jp での取り扱い開始日',
            '上架時間',
            'Im Angebot von Amazon.de seit',
            'Producto en Amazon.es desde',
            'Date de mise en ligne sur Amazon.fr'
        ];

        // 转义正则特殊字符
        const escapeRegExp = (string) => {
            return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        };

        // 构建提取正则： (?:KEYWORD)[:\s]+(.+)
        const extractionRegex = new RegExp(`(?:${rawKeywords.map(escapeRegExp).join('|')})[:\\s]+([^\\n]+)`, 'i');

        // 优先使用精确选择器
        const dateCell = document.querySelector('#productDetails_detailBullets_sections1 > tbody > tr:nth-child(4) > td');
        if (dateCell) {
            let text = dateCell.innerText.trim();

            // 尝试提取日期部分
            const match = text.match(extractionRegex);
            if (match) {
                return parseDateToStandard(match[1].trim());
            }

            // 如果没有匹配到关键词（可能没有前缀），且包含年份，尝试直接返回
            // 简单的长度限制防止返回大段文本
            if (/\d{4}/.test(text) && text.length < 50) {
                return parseDateToStandard(text);
            }
        }

        // 方式2: XPath文本搜索 (适配各国语言)
        try {
            for (const keyword of rawKeywords) {
                const xpath = `//*[contains(text(), "${keyword}")]`;
                const xpathResult = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                const node = xpathResult.singleNodeValue;
                if (node) {
                    // 查找包含日期值的元素
                    // DOM结构可能是: <tr><th>标签</th><td>日期值</td></tr>
                    // 或者: <span>标签</span><span>日期值</span>
                    let valueText = '';

                    // 策略1: 如果节点本身是th，查找相邻td
                    if (node.tagName === 'TH') {
                        const td = node.nextElementSibling;
                        if (td && td.tagName === 'TD') {
                            valueText = td.textContent.trim();
                        }
                    }

                    // 策略2: 向上遍历查找th，然后找相邻td
                    if (!valueText) {
                        let current = node;
                        while (current && current.tagName !== 'TH' && current.tagName !== 'TR') {
                            current = current.parentElement;
                        }
                        if (current && current.tagName === 'TH') {
                            const td = current.nextElementSibling;
                            if (td && td.tagName === 'TD') {
                                valueText = td.textContent.trim();
                            }
                        }
                    }

                    // 策略3: 检查当前节点的兄弟元素
                    if (!valueText && node.nextElementSibling) {
                        valueText = node.nextElementSibling.textContent.trim();
                    }

                    // 策略4: 检查父元素的兄弟元素
                    if (!valueText && node.parentElement && node.parentElement.nextElementSibling) {
                        valueText = node.parentElement.nextElementSibling.textContent.trim();
                    }

                    // 策略5: 在tr中查找td
                    if (!valueText) {
                        let tr = node.closest ? node.closest('tr') : null;
                        if (!tr && node.parentElement) tr = node.parentElement.closest ? node.parentElement.closest('tr') : null;
                        if (tr) {
                            const tds = tr.querySelectorAll('td');
                            if (tds.length > 0) {
                                valueText = tds[tds.length - 1].textContent.trim();
                            }
                        }
                    }

                    // 验证是否像日期且不包含关键词
                    if (valueText && /\d{4}|\d{1,2}\s+\w+\s+\d{4}|jan|feb|mar|apr|mai|jun|jul|aug|sep|oct|nov|dec/i.test(valueText) && valueText.length < 50) {
                        // 确保不包含关键词前缀
                        const hasKeyword = rawKeywords.some(kw => valueText.toLowerCase().includes(kw.toLowerCase().substring(0, 10)));
                        if (!hasKeyword) {
                            return parseDateToStandard(valueText);
                        }
                    }

                    // 备用: 使用正则提取
                    let text = node.textContent;
                    const parent = node.parentElement;
                    if (parent) text += ' ' + parent.textContent;
                    if (parent && parent.nextElementSibling) text += ' ' + parent.nextElementSibling.textContent;

                    const dateMatch = text.match(new RegExp(`(?:${escapeRegExp(keyword)})[:\\s\\t]+([^\\n]+?)(?:\\s*${escapeRegExp(keyword)}|$)`, 'i'));
                    if (dateMatch) {
                        const extracted = dateMatch[1].trim();
                        const hasKeyword = rawKeywords.some(kw => extracted.toLowerCase().includes(kw.toLowerCase().substring(0, 10)));
                        if (!hasKeyword) {
                            return parseDateToStandard(extracted);
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('XPath搜索上架日期失败:', e);
        }

        // 方式3: 从产品详情区域通用文本搜索
        const detailsSection = document.getElementById('productDetails_detailBullets_sections1') ||
            document.getElementById('detailBulletsWrapper_feature_div') ||
            document.getElementById('productDetails_db_sections');

        if (detailsSection) {
            const text = detailsSection.innerText || '';
            const dateMatch = text.match(extractionRegex);
            if (dateMatch) {
                return parseDateToStandard(dateMatch[1].trim());
            }
        }

        return '';
    }

    // 将多语言日期转换为标准格式 YYYY/M/D
    function parseDateToStandard(dateStr) {
        if (!dateStr) return '';

        // 月份映射表 (多语言)
        const monthMap = {
            // 英语
            'january': 1, 'february': 2, 'march': 3, 'april': 4, 'may': 5, 'june': 6,
            'july': 7, 'august': 8, 'september': 9, 'october': 10, 'november': 11, 'december': 12,
            'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'jun': 6, 'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12,
            // 法语
            'janvier': 1, 'février': 2, 'mars': 3, 'avril': 4, 'mai': 5, 'juin': 6,
            'juillet': 7, 'août': 8, 'septembre': 9, 'octobre': 10, 'novembre': 11, 'décembre': 12,
            'janv': 1, 'fév': 2, 'avr': 4, 'juil': 7, 'sept': 9,
            // 德语
            'januar': 1, 'februar': 2, 'märz': 3, 'marz': 3, 'juni': 6, 'juli': 7, 'oktober': 10, 'dezember': 12,
            // 西班牙语
            'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4, 'mayo': 5, 'junio': 6,
            'julio': 7, 'agosto': 8, 'septiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12,
            // 意大利语
            'gennaio': 1, 'febbraio': 2, 'aprile': 4, 'maggio': 5, 'giugno': 6,
            'luglio': 7, 'settembre': 9, 'ottobre': 10, 'dicembre': 12
        };

        // 清理字符串
        let clean = dateStr.toLowerCase().trim();

        // 尝试匹配常见格式
        let day, month, year;

        // 格式1: "22 mai 2025" 或 "8. Mai 2025" (日 月名 年)
        let match = clean.match(/(\d{1,2})\.?\s+([a-zà-ÿ]+)\.?\s+(\d{4})/i);
        if (match) {
            day = parseInt(match[1]);
            month = monthMap[match[2].toLowerCase()];
            year = parseInt(match[3]);
        }

        // 格式2: "October 24, 2025" (月名 日, 年)
        if (!year) {
            match = clean.match(/([a-zà-ÿ]+)\.?\s+(\d{1,2}),?\s+(\d{4})/i);
            if (match) {
                month = monthMap[match[1].toLowerCase()];
                day = parseInt(match[2]);
                year = parseInt(match[3]);
            }
        }

        // 格式3: "2025/10/24" 或 "2025-10-24" (年/月/日)
        if (!year) {
            match = clean.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
            if (match) {
                year = parseInt(match[1]);
                month = parseInt(match[2]);
                day = parseInt(match[3]);
            }
        }

        // 格式4: "24/10/2025" 或 "24-10-2025" (日/月/年)
        if (!year) {
            match = clean.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
            if (match) {
                day = parseInt(match[1]);
                month = parseInt(match[2]);
                year = parseInt(match[3]);
            }
        }

        // 如果成功解析，返回标准格式
        if (year && month && day) {
            return `${year}/${month}/${day}`;
        }

        // 解析失败，返回原始字符串
        return dateStr;
    }

    // 获取评论 - 修复：获取完整评论内容
    function getReviews() {
        const reviews = [];

        // 主要评论区
        const reviewElements = document.querySelectorAll('[data-hook="review"], .review');

        reviewElements.forEach(el => {
            const review = {
                评论ID: el.id || el.getAttribute('data-review-id') || '',
                评分: 0,
                标题: '',
                内容: '',
                日期: '',
                已验证购买: false,
                有用数: 0,
                变体信息: ''
            };

            // 评分
            const ratingEl = el.querySelector('.a-icon-alt, [data-hook="review-star-rating"] .a-icon-alt');
            if (ratingEl) {
                const match = ratingEl.innerText.match(/([\d,.]+)/);
                if (match) review.评分 = parseInt(match[1].replace(',', '.'));
            }

            // 标题 - 多种选择器
            const titleSelectors = [
                '[data-hook="review-title"] span:not(.a-icon-alt)',
                '.review-title span',
                '.review-title-content',
                'a[data-hook="review-title"]'
            ];
            for (const selector of titleSelectors) {
                const titleEl = el.querySelector(selector);
                if (titleEl && titleEl.innerText.trim()) {
                    review.标题 = titleEl.innerText.trim();
                    break;
                }
            }

            // 内容 - 获取完整评论文本
            const bodySelectors = [
                '[data-hook="review-body"] span',
                '.review-text-content span',
                '.review-text span'
            ];
            for (const selector of bodySelectors) {
                const bodyEl = el.querySelector(selector);
                if (bodyEl && bodyEl.innerText.trim()) {
                    review.内容 = bodyEl.innerText.trim();
                    break;
                }
            }

            // 日期
            const dateEl = el.querySelector('[data-hook="review-date"]');
            if (dateEl) review.日期 = dateEl.innerText.trim();

            // 已验证购买
            const verifiedEl = el.querySelector('[data-hook="avp-badge"], .avp-badge');
            review.已验证购买 = !!verifiedEl;

            // 有用数
            const helpfulEl = el.querySelector('[data-hook="helpful-vote-statement"]');
            if (helpfulEl) {
                const match = helpfulEl.innerText.match(/(\d+)/);
                if (match) review.有用数 = parseInt(match[1]);
            }

            // 变体信息
            const variantEl = el.querySelector('[data-hook="format-strip"]');
            if (variantEl) review.变体信息 = variantEl.innerText.trim();

            // 只添加有内容的评论
            if (review.标题 || review.内容) {
                reviews.push(review);
            }
        });

        return reviews;
    }

    // 汇总采集所有数据
    function collectAllData() {
        const ratings = getRating();
        const bsr = getBSR();
        const images = getImages();
        const aplusImages = getAPlusImages();
        const reviews = getReviews();

        // 将评论列表格式化为文本
        const reviewsText = reviews.map((r, i) => {
            return `【${i + 1}】⭐${r.评分} ${r.已验证购买 ? '✓已验证' : ''}\n` +
                `标题: ${r.标题 || '无'}\n` +
                `内容: ${r.内容}\n` +
                `${r.变体信息 ? '变体: ' + r.变体信息 : ''}`;
        }).join('\n\n---\n\n');

        return {
            // 本地SKU - 手动填写
            本地SKU: '',

            // 基本标识
            ASIN: getASIN(),
            链接: window.location.href,
            站点: getMarketCode(),
            采集时间: new Date().toISOString(),

            // 核心内容
            标题: getTitle(),
            品牌: getBrand(),
            五点描述: getBulletPoints(),
            产品描述: getDescription(),

            // 图片
            图片: images,
            A加图片: aplusImages,

            // 排名
            销售排名: bsr,
            上架日期: getListingDate(),
            评分: ratings.评分,
            评论数: ratings.评论数,

            // 评论
            评论列表: reviews,
            评论汇总: reviewsText,

            // 采集状态
            采集状态: '成功'
        };
    }

    // ==================== 飞书API ====================

    // 获取飞书访问令牌
    async function getFeishuToken(appId, appSecret) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ app_id: appId, app_secret: appSecret }),
                onload: function (response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (data.code === 0) resolve(data.tenant_access_token);
                        else reject(new Error(data.msg || '获取Token失败'));
                    } catch (e) { reject(e); }
                },
                onerror: reject
            });
        });
    }

    // 获取飞书表格现有字段列表
    async function getFeishuFields(token, appToken, tableId) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
                headers: { 'Authorization': `Bearer ${token}` },
                onload: function (response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (data.code === 0) resolve(data.data.items || []);
                        else reject(new Error(data.msg || '获取字段失败'));
                    } catch (e) { reject(e); }
                },
                onerror: reject
            });
        });
    }

    // 创建飞书表格字段
    async function createFeishuField(token, appToken, tableId, fieldName, fieldType) {
        const typeMap = {
            'text': 1, 'number': 2, 'select': 3, 'date': 5, 'url': 15
        };
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                data: JSON.stringify({ field_name: fieldName, type: typeMap[fieldType] || 1 }),
                onload: function (response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (data.code === 0) resolve(data.data.field);
                        else reject(new Error(data.msg || '创建字段失败'));
                    } catch (e) { reject(e); }
                },
                onerror: reject
            });
        });
    }

    // 确保所有需要的字段存在
    async function ensureFeishuFields(token, appToken, tableId) {
        const requiredFields = [
            { name: '本地SKU', type: 'text' },
            { name: 'ASIN', type: 'text' },
            { name: '站点', type: 'text' },
            { name: '链接', type: 'url' },
            { name: '标题', type: 'text' },
            { name: '品牌', type: 'text' },
            { name: '五点1', type: 'text' },
            { name: '五点2', type: 'text' },
            { name: '五点3', type: 'text' },
            { name: '五点4', type: 'text' },
            { name: '五点5', type: 'text' },
            { name: '五点6', type: 'text' },
            { name: '产品描述', type: 'text' },
            { name: '评分', type: 'number' },
            { name: '评论数', type: 'number' },
            { name: 'BSR排名', type: 'url' },
            { name: 'BSR小类目', type: 'url' },
            { name: '上架日期', type: 'text' },
            { name: '评论内容', type: 'text' },
            { name: '主图', type: 'text' },
            { name: '副图1', type: 'text' },
            { name: '副图2', type: 'text' },
            { name: '副图3', type: 'text' },
            { name: '副图4', type: 'text' },
            { name: '副图5', type: 'text' },
            { name: '副图6', type: 'text' },
            { name: '副图7', type: 'text' },
            { name: '副图8', type: 'text' },
            { name: 'A+图片', type: 'text' },
            { name: '采集时间', type: 'date' }
        ];

        const existingFields = await getFeishuFields(token, appToken, tableId);
        const existingNames = new Set(existingFields.map(f => f.field_name));
        const createdFields = [];

        for (const field of requiredFields) {
            if (!existingNames.has(field.name)) {
                try {
                    await createFeishuField(token, appToken, tableId, field.name, field.type);
                    createdFields.push(field.name);
                    console.log(`创建字段: ${field.name}`);
                } catch (e) {
                    console.warn(`创建字段 ${field.name} 失败:`, e);
                }
            }
        }
        return createdFields;
    }

    // 写入飞书多维表格
    async function writeToFeishu(config, data, statusCallback) {
        const token = await getFeishuToken(config.飞书.appId, config.飞书.appSecret);

        // 检测并创建缺失字段
        if (statusCallback) statusCallback('检测表格字段...');
        const createdFields = await ensureFeishuFields(token, config.飞书.appToken, config.飞书.tableId);
        if (createdFields.length > 0) {
            console.log(`已创建 ${createdFields.length} 个新字段`);
        }

        if (statusCallback) statusCallback('正在写入数据...');

        // 构建记录数据
        const fields = {
            '本地SKU': data.本地SKU,
            'ASIN': data.ASIN,
            '站点': data.站点,
            '链接': { link: data.链接, text: data.ASIN },
            '标题': data.标题,
            '品牌': data.品牌,
            '五点1': data.五点描述[0] || '',
            '五点2': data.五点描述[1] || '',
            '五点3': data.五点描述[2] || '',
            '五点4': data.五点描述[3] || '',
            '五点5': data.五点描述[4] || '',
            '五点6': data.五点描述[5] || '',
            '产品描述': data.产品描述,
            '评分': data.评分 || 0,
            '评论数': data.评论数 || 0,
            'BSR排名': data.销售排名.排名 ? {
                link: data.销售排名.类目链接 || data.链接,
                text: `#${data.销售排名.排名} in ${data.销售排名.类目}`
            } : null,
            'BSR小类目': data.销售排名.小类目排名 ? {
                link: data.销售排名.小类目链接 || data.链接,
                text: `#${data.销售排名.小类目排名} in ${data.销售排名.小类目}`
            } : null,
            '上架日期': data.上架日期 || '',
            '评论内容': data.评论汇总 || '',
            '主图': data.图片.主图,
            '副图1': data.图片.副图1,
            '副图2': data.图片.副图2,
            '副图3': data.图片.副图3,
            '副图4': data.图片.副图4,
            '副图5': data.图片.副图5,
            '副图6': data.图片.副图6,
            '副图7': data.图片.副图7,
            '副图8': data.图片.副图8,
            'A+图片': (data.A加图片 || []).join('\n'),
            '采集时间': new Date().getTime()
        };

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.飞书.appToken}/tables/${config.飞书.tableId}/records`,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                data: JSON.stringify({ fields }),
                onload: function (response) {
                    try {
                        const result = JSON.parse(response.responseText);
                        if (result.code === 0) resolve(result);
                        else reject(new Error(result.msg || '写入失败'));
                    } catch (e) { reject(e); }
                },
                onerror: reject
            });
        });
    }

    // ==================== 本地API ====================

    async function writeToLocalAPI(config, data) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: config.本地API.地址 + config.本地API.端点,
                headers: {
                    'Content-Type': 'application/json'
                },
                data: JSON.stringify(data),
                onload: function (response) {
                    try {
                        const result = JSON.parse(response.responseText);
                        if (result.success || result.成功) {
                            resolve(result);
                        } else {
                            reject(new Error(result.error || result.错误 || '写入失败'));
                        }
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror: function (error) {
                    reject(error);
                }
            });
        });
    }

    // ==================== 配置界面 ====================

    function createConfigPanel() {
        const config = getConfig();

        // 创建遮罩层
        const overlay = document.createElement('div');
        overlay.id = 'collector-config-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.5);
            z-index: 99999;
            display: flex;
            justify-content: center;
            align-items: center;
        `;

        // 配置面板
        const panel = document.createElement('div');
        panel.style.cssText = `
            background: #fff;
            border-radius: 12px;
            padding: 24px;
            width: 500px;
            max-width: 90%;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        `;

        panel.innerHTML = `
            <h2 style="margin: 0 0 20px; color: #333; font-size: 20px;">⚙️ 竞品采集配置</h2>
            
            <!-- 方案选择 -->
            <div style="margin-bottom: 20px;">
                <label style="font-weight: bold; color: #333;">选择方案:</label>
                <div style="margin-top: 8px;">
                    <label style="margin-right: 20px; cursor: pointer;">
                        <input type="radio" name="scheme" value="feishu" ${config.方案 === 'feishu' ? 'checked' : ''}>
                        飞书多维表格
                    </label>
                    <label style="cursor: pointer;">
                        <input type="radio" name="scheme" value="localapi" ${config.方案 === 'localapi' ? 'checked' : ''}>
                        本地API服务
                    </label>
                </div>
            </div>
            
            <!-- 飞书配置区 -->
            <div id="feishu-config" style="display: ${config.方案 === 'feishu' ? 'block' : 'none'}; padding: 15px; background: #f5f5f5; border-radius: 8px; margin-bottom: 15px;">
                <h3 style="margin: 0 0 15px; font-size: 16px; color: #1890ff;">📊 飞书配置</h3>
                
                <div style="margin-bottom: 12px;">
                    <label style="display: block; margin-bottom: 4px; font-size: 13px;">App ID:</label>
                    <input type="text" id="feishu-appid" value="${config.飞书.appId}" 
                        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;">
                </div>
                
                <div style="margin-bottom: 12px;">
                    <label style="display: block; margin-bottom: 4px; font-size: 13px;">App Secret:</label>
                    <input type="password" id="feishu-secret" value="${config.飞书.appSecret}" 
                        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;">
                </div>
                
                <div style="margin-bottom: 12px;">
                    <label style="display: block; margin-bottom: 4px; font-size: 13px;">多维表格链接:</label>
                    <input type="text" id="feishu-url" value="${config.飞书.表格链接}" 
                        placeholder="粘贴飞书多维表格的完整链接"
                        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;">
                    <small style="color: #888;">将自动解析出 appToken 和 tableId</small>
                </div>
                
                <div style="margin-bottom: 12px; padding: 8px; background: #fff; border-radius: 4px; font-size: 12px;">
                    <div>App Token: <span id="parsed-apptoken">${config.飞书.appToken || '-'}</span></div>
                    <div>Table ID: <span id="parsed-tableid">${config.飞书.tableId || '-'}</span></div>
                </div>
                
                <button id="test-feishu" style="padding: 8px 16px; background: #1890ff; color: #fff; border: none; border-radius: 4px; cursor: pointer;">
                    测试连接
                </button>
                <span id="feishu-test-result" style="margin-left: 10px; font-size: 13px;"></span>
            </div>
            
            <!-- 本地API配置区 -->
            <div id="localapi-config" style="display: ${config.方案 === 'localapi' ? 'block' : 'none'}; padding: 15px; background: #f5f5f5; border-radius: 8px; margin-bottom: 15px;">
                <h3 style="margin: 0 0 15px; font-size: 16px; color: #52c41a;">🖥️ 本地API配置</h3>
                
                <div style="margin-bottom: 12px;">
                    <label style="display: block; margin-bottom: 4px; font-size: 13px;">API地址:</label>
                    <input type="text" id="api-url" value="${config.本地API.地址}" 
                        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;">
                </div>
                
                <div style="margin-bottom: 12px;">
                    <label style="display: block; margin-bottom: 4px; font-size: 13px;">API端点:</label>
                    <input type="text" id="api-endpoint" value="${config.本地API.端点}" 
                        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;">
                </div>
                
                <button id="test-localapi" style="padding: 8px 16px; background: #52c41a; color: #fff; border: none; border-radius: 4px; cursor: pointer;">
                    测试连接
                </button>
                <span id="localapi-test-result" style="margin-left: 10px; font-size: 13px;"></span>
            </div>
            
            <!-- 按钮区 -->
            <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
                <button id="config-cancel" style="padding: 10px 20px; background: #f5f5f5; border: 1px solid #ddd; border-radius: 4px; cursor: pointer;">
                    取消
                </button>
                <button id="config-save" style="padding: 10px 20px; background: #ff9900; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">
                    保存配置
                </button>
            </div>
        `;

        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        // 绑定事件

        // 方案切换
        panel.querySelectorAll('input[name="scheme"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                document.getElementById('feishu-config').style.display = e.target.value === 'feishu' ? 'block' : 'none';
                document.getElementById('localapi-config').style.display = e.target.value === 'localapi' ? 'block' : 'none';
            });
        });

        // 解析飞书链接
        document.getElementById('feishu-url').addEventListener('input', (e) => {
            const parsed = parseFeishuUrl(e.target.value);
            document.getElementById('parsed-apptoken').textContent = parsed.appToken || '-';
            document.getElementById('parsed-tableid').textContent = parsed.tableId || '-';
        });

        // 测试飞书连接
        document.getElementById('test-feishu').addEventListener('click', async () => {
            const resultEl = document.getElementById('feishu-test-result');
            resultEl.textContent = '测试中...';
            resultEl.style.color = '#888';

            try {
                const appId = document.getElementById('feishu-appid').value;
                const appSecret = document.getElementById('feishu-secret').value;

                if (!appId || !appSecret) {
                    throw new Error('请填写App ID和App Secret');
                }

                const token = await getFeishuToken(appId, appSecret);
                resultEl.textContent = '✅ 连接成功！';
                resultEl.style.color = '#52c41a';
            } catch (e) {
                resultEl.textContent = '❌ ' + e.message;
                resultEl.style.color = '#ff4d4f';
            }
        });

        // 测试本地API
        document.getElementById('test-localapi').addEventListener('click', () => {
            const resultEl = document.getElementById('localapi-test-result');
            resultEl.textContent = '测试中...';
            resultEl.style.color = '#888';

            const apiUrl = document.getElementById('api-url').value;

            GM_xmlhttpRequest({
                method: 'GET',
                url: apiUrl + '/health',
                timeout: 5000,
                onload: function (response) {
                    if (response.status === 200) {
                        resultEl.textContent = '✅ 连接成功！';
                        resultEl.style.color = '#52c41a';
                    } else {
                        resultEl.textContent = '❌ 服务响应异常';
                        resultEl.style.color = '#ff4d4f';
                    }
                },
                onerror: function () {
                    resultEl.textContent = '❌ 无法连接到服务';
                    resultEl.style.color = '#ff4d4f';
                },
                ontimeout: function () {
                    resultEl.textContent = '❌ 连接超时';
                    resultEl.style.color = '#ff4d4f';
                }
            });
        });

        // 取消
        document.getElementById('config-cancel').addEventListener('click', () => {
            document.body.removeChild(overlay);
        });

        // 保存
        document.getElementById('config-save').addEventListener('click', () => {
            const newConfig = {
                方案: document.querySelector('input[name="scheme"]:checked').value,
                飞书: {
                    appId: document.getElementById('feishu-appid').value,
                    appSecret: document.getElementById('feishu-secret').value,
                    表格链接: document.getElementById('feishu-url').value,
                    ...parseFeishuUrl(document.getElementById('feishu-url').value)
                },
                本地API: {
                    地址: document.getElementById('api-url').value,
                    端点: document.getElementById('api-endpoint').value
                }
            };

            saveConfig(newConfig);
            document.body.removeChild(overlay);
            alert('配置已保存！');
        });

        // 点击遮罩关闭
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
            }
        });
    }

    // ==================== 采集弹窗 ====================

    function createCollectorPopup() {
        const config = getConfig();
        const data = collectAllData();

        // 创建弹窗
        const popup = document.createElement('div');
        popup.id = 'collector-popup';
        popup.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: #fff;
            border-radius: 10px;
            padding: 16px;
            width: 580px;
            max-width: 95%;
            max-height: 85vh;
            overflow-y: auto;
            box-shadow: 0 8px 30px rgba(0,0,0,0.3);
            z-index: 99999;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        `;

        // 拖动功能
        let isDragging = false, offsetX, offsetY;
        popup.addEventListener('mousedown', (e) => {
            if (!['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT'].includes(e.target.tagName)) {
                isDragging = true;
                offsetX = e.clientX - popup.offsetLeft;
                offsetY = e.clientY - popup.offsetTop;
                popup.style.cursor = 'grabbing';
            }
        });
        document.addEventListener('mousemove', (e) => {
            if (isDragging) {
                popup.style.left = `${e.clientX - offsetX}px`;
                popup.style.top = `${e.clientY - offsetY}px`;
                popup.style.transform = 'none';
            }
        });
        document.addEventListener('mouseup', () => {
            isDragging = false;
            popup.style.cursor = 'default';
        });

        // 生成评论预览HTML
        const reviewsHtml = data.评论列表.slice(0, 5).map(r => `
            <div style="margin-bottom: 8px; padding: 8px; background: #fff; border-radius: 4px; border-left: 3px solid ${r.评分 >= 4 ? '#52c41a' : r.评分 >= 3 ? '#faad14' : '#ff4d4f'};">
                <div style="font-size: 12px; color: #888;">⭐${r.评分} | ${r.日期}</div>
                <div style="font-weight: bold; margin: 4px 0;">${r.标题 || '无标题'}</div>
                <div style="font-size: 12px; color: #666; max-height: 40px; overflow: hidden;">${r.内容.substring(0, 100)}${r.内容.length > 100 ? '...' : ''}</div>
            </div>
        `).join('') || '<div style="color: #888;">当前页面无评论</div>';

        popup.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; position: relative;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span id="popup-title" style="font-size: 20px;">🛒</span>
                    <span id="popup-title-text" style="font-weight: bold; color: #333;">竞品采集</span>
                </div>
                <div style="display: flex; gap: 6px; align-items: center;">
                    <button id="btn-submit-top" style="background: #ff9900; color: #fff; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold;">📤 提交</button>
                    <button id="btn-capture-aplus" style="background: #13c2c2; color: #fff; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;">📸</button>
                    <button id="popup-settings" style="background: #595959; color: #fff; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;">⚙️</button>
                    <span style="background: #${config.方案 === 'feishu' ? '1890ff' : '52c41a'}; color: #fff; padding: 4px 10px; border-radius: 12px; font-size: 11px;">
                        ${config.方案 === 'feishu' ? '飞书' : 'API'}
                    </span>
                    <button id="btn-toggle-collapse" style="background: #722ed1; color: #fff; border: none; width: 28px; height: 28px; border-radius: 4px; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center;">▼</button>
                </div>
            </div>
            
            <!-- 本地SKU - 始终显示 -->
            <div style="margin-bottom: 8px; padding: 8px; background: #fff7e6; border: 1px solid #ffd591; border-radius: 4px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <label style="font-size: 12px; font-weight: bold; color: #d46b08; white-space: nowrap;">📦 SKU:</label>
                    <input type="text" id="edit-localsku" value="${GM_getValue('lastLocalSku', '')}" placeholder="输入本地SKU"
                        style="flex: 1; padding: 8px; border: 2px solid #ffd591; border-radius: 4px; box-sizing: border-box; font-size: 13px;">
                </div>
            </div>
            
            <!-- 顶部状态提示 - 始终可见 -->
            <div id="submit-status-top" style="margin-bottom: 8px; padding: 6px 10px; border-radius: 4px; display: none; font-size: 11px;"></div>
            
            <!-- 可折叠内容区域 -->
            <div id="collapsible-content">

                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 8px; margin-bottom: 10px;">
                    <div style="background: #f5f5f5; padding: 10px; border-radius: 6px;">
                        <div style="font-size: 11px; color: #888;">ASIN</div>
                        <div style="font-weight: bold; color: #333;">${data.ASIN}</div>
                    </div>
                    <div style="background: #f5f5f5; padding: 6px 8px; border-radius: 4px;">
                        <div style="font-size: 11px; color: #888;">站点</div>
                        <div style="font-weight: bold; color: #333;">${data.站点}</div>
                    </div>
                    <div style="background: #f5f5f5; padding: 6px 8px; border-radius: 4px;">
                        <div style="font-size: 11px; color: #888;">评分</div>
                        <div style="font-weight: bold; color: #333;">⭐ ${data.评分} (${data.评论数}条)</div>
                    </div>
                    <div style="background: #e6f7ff; padding: 6px 8px; border-radius: 4px; border: 1px solid #91d5ff;">
                        <div style="font-size: 11px; color: #1890ff;">上架日期</div>
                        <div style="font-weight: bold; color: #1890ff;">📅 ${data.上架日期 || '未获取'}</div>
                    </div>
                </div>

                <div style="margin-bottom: 12px;">
                    <label style="display: block; margin-bottom: 2px; font-size: 12px; font-weight: bold;">标题:</label>
                    <textarea id="edit-title" style="width: 100%; height: 40px; padding: 6px; border: 1px solid #ddd; border-radius: 4px; resize: vertical; box-sizing: border-box; font-size: 11px;">${data.标题}</textarea>
                </div>

                <div style="margin-bottom: 8px;">
                    <label style="display: block; margin-bottom: 2px; font-size: 12px; font-weight: bold;">品牌:</label>
                    <input type="text" id="edit-brand" value="${data.品牌}" style="width: 100%; padding: 6px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; font-size: 11px;">
                </div>

                <div style="margin-bottom: 8px;">
                    <label style="display: block; margin-bottom: 2px; font-size: 12px; font-weight: bold;">五点描述 (${data.五点描述.length}条):</label>
                    <textarea id="edit-bullets" style="width: 100%; height: 60px; padding: 6px; border: 1px solid #ddd; border-radius: 4px; resize: vertical; box-sizing: border-box; font-size: 10px;">${data.五点描述.join('\n')}</textarea>
                </div>

                <div style="margin-bottom: 8px;">
                    <label style="display: block; margin-bottom: 2px; font-size: 12px; font-weight: bold;">产品描述:</label>
                    <textarea id="edit-desc" style="width: 100%; height: 50px; padding: 6px; border: 1px solid #ddd; border-radius: 4px; resize: vertical; box-sizing: border-box; font-size: 10px;">${data.产品描述}</textarea>
                </div>

                <!-- 图片信息 -->
                <div style="margin-bottom: 8px; padding: 8px; background: #f0f9ff; border: 1px solid #91d5ff; border-radius: 4px;">
                    <div style="font-size: 12px; font-weight: bold; margin-bottom: 4px;">🖼️ 图片采集</div>
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; font-size: 10px;">
                        <div>主图: ${data.图片.主图 ? '✅' : '❌'}</div>
                        <div>副图1: ${data.图片.副图1 ? '✅' : '❌'}</div>
                        <div>副图2: ${data.图片.副图2 ? '✅' : '❌'}</div>
                        <div>副图3: ${data.图片.副图3 ? '✅' : '❌'}</div>
                        <div>副图4: ${data.图片.副图4 ? '✅' : '❌'}</div>
                        <div>A+图片: ${data.A加图片.length}张</div>
                    </div>
                </div>



                <div style="margin-bottom: 16px;">
                    <div style="font-size: 13px; font-weight: bold; margin-bottom: 8px;">💬 评论预览 (${data.评论列表.length}条)</div>
                    <div style="max-height: 150px; overflow-y: auto; background: #f9f9f9; padding: 8px; border-radius: 4px;">
                        ${reviewsHtml}
                    </div>
                </div>

                <div id="submit-status" style="margin-bottom: 12px; padding: 10px; border-radius: 6px; display: none;"></div>

                <div style="display: flex; justify-content: flex-end; gap: 10px;">
                    <button id="popup-settings-bottom" style="padding: 10px 16px; background: #f5f5f5; border: 1px solid #ddd; border-radius: 4px; cursor: pointer;">
                        ⚙️ 设置
                    </button>
                    <button id="popup-close" style="padding: 10px 16px; background: #f5f5f5; border: 1px solid #ddd; border-radius: 4px; cursor: pointer;">
                        取消
                    </button>
                    <button id="popup-submit" style="padding: 10px 20px; background: #ff9900; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">
                        📤 提交采集
                    </button>
                </div>
                </div>
            </div>
            `;

        document.body.appendChild(popup);

        // 折叠按钮事件
        let isCollapsed = false;
        document.getElementById('btn-toggle-collapse').addEventListener('click', () => {
            const content = document.getElementById('collapsible-content');
            const btn = document.getElementById('btn-toggle-collapse');
            const titleText = document.getElementById('popup-title-text');
            if (isCollapsed) {
                content.style.display = 'block';
                popup.style.width = '600px';
                popup.style.minWidth = '';
                btn.textContent = '▼';
                if (titleText) titleText.style.display = 'inline';
                isCollapsed = false;
            } else {
                content.style.display = 'none';
                popup.style.width = '380px';
                popup.style.minWidth = '380px';
                btn.textContent = '▲';
                if (titleText) titleText.style.display = 'none';
                isCollapsed = true;
            }
        });

        // 绑定事件 - 顶部设置按钮
        document.getElementById('popup-settings').addEventListener('click', () => {
            document.body.removeChild(popup);
            createConfigPanel();
        });

        // 绑定事件 - 底部设置按钮
        document.getElementById('popup-settings-bottom').addEventListener('click', () => {
            document.body.removeChild(popup);
            createConfigPanel();
        });

        document.getElementById('popup-close').addEventListener('click', () => {
            document.body.removeChild(popup);
        });

        // A+截图事件
        document.getElementById('btn-capture-aplus').addEventListener('click', captureAplus);

        const submitHandler = async () => {
            const localSku = document.getElementById('edit-localsku').value.trim();

            // 验证本地SKU
            if (!localSku) {
                alert('请填写本地SKU！');
                document.getElementById('edit-localsku').focus();
                return;
            }

            // 获取两个提交按钮
            const btnBottom = document.getElementById('popup-submit');
            const btnTop = document.getElementById('btn-submit-top');

            // 禁用按钮
            if (btnBottom) { btnBottom.disabled = true; btnBottom.textContent = '提交中...'; }
            if (btnTop) { btnTop.disabled = true; btnTop.textContent = '⏳'; }

            // 获取状态显示元素
            const statusEl = document.getElementById('submit-status');
            const statusTopEl = document.getElementById('submit-status-top');

            const updateStatus = (bg, border, text) => {
                if (statusEl) {
                    statusEl.style.display = 'block';
                    statusEl.style.background = bg;
                    statusEl.style.border = border;
                    statusEl.innerHTML = text;
                }
                if (statusTopEl) {
                    statusTopEl.style.display = 'block';
                    statusTopEl.style.background = bg;
                    statusTopEl.style.border = border;
                    statusTopEl.innerHTML = text;
                }
            };

            updateStatus('#e6f7ff', '1px solid #91d5ff', '⏳ 正在提交数据...');

            // 更新编辑后的数据
            data.本地SKU = localSku;
            data.标题 = document.getElementById('edit-title').value;
            data.品牌 = document.getElementById('edit-brand').value;
            data.五点描述 = document.getElementById('edit-bullets').value.split('\n').filter(s => s.trim());
            data.产品描述 = document.getElementById('edit-desc').value;

            try {
                if (config.方案 === 'feishu') {
                    if (!config.飞书.appId || !config.飞书.appSecret || !config.飞书.appToken) {
                        throw new Error('请先配置飞书信息');
                    }
                    await writeToFeishu(config, data, (msg) => {
                        updateStatus('#e6f7ff', '1px solid #91d5ff', '⏳ ' + msg);
                    });
                } else {
                    await writeToLocalAPI(config, data);
                }

                updateStatus('#f6ffed', '1px solid #b7eb8f', '✅ <b>提交成功！</b> 数据已同步');

                // 保存本地SKU以便下次使用
                GM_setValue('lastLocalSku', localSku);

                // 恢复按钮为"再次提交"
                if (btnBottom) { btnBottom.disabled = false; btnBottom.textContent = '📤 再次提交'; }
                if (btnTop) { btnTop.disabled = false; btnTop.textContent = '✅'; }

            } catch (e) {
                updateStatus('#fff2f0', '1px solid #ffccc7', '❌ ' + e.message);

                // 恢复按钮
                if (btnBottom) { btnBottom.disabled = false; btnBottom.textContent = '📤 重新提交'; }
                if (btnTop) { btnTop.disabled = false; btnTop.textContent = '📤'; }
            }
        };

        // 绑定底部提交按钮
        document.getElementById('popup-submit').addEventListener('click', submitHandler);
        // 绑定顶部提交按钮
        document.getElementById('btn-submit-top').addEventListener('click', submitHandler);
    }

    // ==================== 主入口 ====================

    // 创建悬浮按钮
    function createFloatingButton() {
        const btn = document.createElement('button');
        btn.id = 'collector-trigger';
        btn.innerHTML = '🎯 采集';
        btn.style.cssText = `
                position: fixed;
                bottom: 100px;
                right: 20px;
                width: 60px;
                height: 60px;
                background: linear-gradient(135deg, #ff9900 0%, #ff6600 100%);
                color: #fff;
                border: none;
                border-radius: 50%;
                font-size: 14px;
                font-weight: bold;
                cursor: pointer;
                box-shadow: 0 4px 15px rgba(255, 153, 0, 0.4);
                z-index: 99998;
                transition: all 0.3s ease;
                `;

        btn.addEventListener('mouseenter', () => {
            btn.style.transform = 'scale(1.1)';
            btn.style.boxShadow = '0 6px 20px rgba(255, 153, 0, 0.5)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.transform = 'scale(1)';
            btn.style.boxShadow = '0 4px 15px rgba(255, 153, 0, 0.4)';
        });

        btn.addEventListener('click', createCollectorPopup);

        document.body.appendChild(btn);
    }

    // 注册菜单命令
    GM_registerMenuCommand('⚙️ 配置', createConfigPanel);
    GM_registerMenuCommand('🎯 采集当前页面', createCollectorPopup);

    // 页面加载完成后显示按钮
    window.addEventListener('load', createFloatingButton);

})();
