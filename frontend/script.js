// Этот файл выполняется в браузере пользователя.
// Он НЕ обращается к Яндекс.Маркету напрямую — это невозможно сделать безопасно,
// потому что токен продавца пришлось бы отдать в браузер. Вместо этого фронт
// ходит на наш собственный бэкенд, который держит токен у себя, обновляет
// каталог по расписанию и отдаёт готовый список товаров.

/**
 * Бэкенд живёт на том же домене: Nginx отдаёт статику и проксирует /api на Node.
 * Если понадобится развести фронт и бэк по разным адресам, задайте до подключения
 * этого файла: <script>window.PANDA_API_BASE = 'https://api.pandaprint.ru'</script>
 * и добавьте этот домен в CORS_ORIGINS на бэкенде.
 */
const API_BASE = window.PANDA_API_BASE || '';

const PRODUCTS_PER_PAGE = 12;
const ALL_CATEGORIES = 'Все категории';
const NO_CATEGORY = 'Без категории';

const SORT_OPTIONS = [
	{ key: 'popular', label: 'Сначала популярные' },
	{ key: 'price-asc', label: 'Сначала дешёвые' },
	{ key: 'price-desc', label: 'Сначала дорогие' },
	{ key: 'discount', label: 'Сначала со скидкой' },
	{ key: 'name-asc', label: 'Название: А–Я' },
	{ key: 'name-desc', label: 'Название: Я–А' },
];

let allProducts = [];
let activeCategory = ALL_CATEGORIES;
let currentPage = 1;
let sortKey = 'popular';
let searchQuery = '';

// Фильтр по цене: элемента слайдера в текущей вёрстке HTML нет, но переменные
// всё равно должны быть объявлены — без этого чтение необъявленного `priceSlider`
// в resetFilters() кидает ReferenceError и обрывает весь сброс фильтров на полпути.
let priceSlider = null;
let priceMin = null;
let priceMax = null;
let priceRangeMin = 0;
let priceRangeMax = 0;

// --- Безопасность вывода ---------------------------------------------------

/**
 * Названия и категории приходят из внешней системы (Маркет). Любая кавычка
 * или угловая скобка в названии товара, попав в innerHTML или в атрибут,
 * ломает вёрстку карточки, поэтому экранируем всё, что подставляем.
 */
function escapeHtml(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** В src и href пускаем только https-ссылки. */
function safeUrl(value) {
	const url = String(value ?? '');
	return url.startsWith('https://') ? url : '';
}

// --- Загрузка каталога -----------------------------------------------------

function setStatus(text) {
	const statusEl = document.getElementById('status');
	if (!statusEl) return;

	if (!text) {
		statusEl.hidden = true;
		return;
	}

	statusEl.hidden = false;
	statusEl.textContent = text;
}

function setToolbarVisible(visible) {
	const toolbar = document.querySelector('.catalog__toolbar');
	if (toolbar) toolbar.hidden = !visible;
}

/**
 * Скелетоны показываются сразу, до ответа сервера: страница не «прыгает»,
 * когда товары доезжают, потому что сетка уже занимает своё место.
 */
function renderSkeletons(count = PRODUCTS_PER_PAGE) {
	const gridEl = document.getElementById('products');
	if (!gridEl) return;

	const card = `
		<div class="product-card product-card--skeleton" aria-hidden="true">
			<div class="skeleton skeleton--image"></div>
			<div class="product-card__body">
				<span class="skeleton skeleton--line skeleton--source"></span>
				<span class="skeleton skeleton--line"></span>
				<span class="skeleton skeleton--line skeleton--short"></span>
				<span class="skeleton skeleton--line skeleton--price"></span>
			</div>
		</div>`;

	gridEl.innerHTML = card.repeat(count);
}

async function loadProducts() {
	setStatus('');
	setToolbarVisible(false);
	renderSkeletons();

	try {
		const response = await fetch(`${API_BASE}/api/products`, {
			headers: { Accept: 'application/json' },
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		const data = await response.json();
		allProducts = Array.isArray(data.products) ? data.products : [];

		if (allProducts.length === 0) {
			document.getElementById('products').innerHTML = '';
			setStatus('Товары не найдены.');
			return;
		}

		setToolbarVisible(true);
		renderFilters();
		renderProducts();
	} catch (error) {
		console.error('Ошибка при загрузке товаров:', error);
		document.getElementById('products').innerHTML = '';
		setStatus('Не получилось загрузить товары. Попробуй обновить страницу.');
	}
}

// --- Фильтрация и сортировка -----------------------------------------------

function discountShare(product) {
	if (!product.oldPrice || !product.price || product.oldPrice <= product.price) return 0;
	return 1 - product.price / product.oldPrice;
}

const SORTERS = {
	'price-asc': (a, b) => a.price - b.price,
	'price-desc': (a, b) => b.price - a.price,
	discount: (a, b) => discountShare(b) - discountShare(a),
	'name-asc': (a, b) => a.name.localeCompare(b.name, 'ru'),
	'name-desc': (a, b) => b.name.localeCompare(a.name, 'ru'),
	// 'popular' сортировщика не имеет: это исходный порядок, в котором
	// товары пришли с Маркета, и к нему нужно уметь вернуться.
};

function getVisibleProducts() {
	let list = allProducts;

	if (activeCategory !== ALL_CATEGORIES) {
		list = list.filter((product) => (product.category || NO_CATEGORY) === activeCategory);
	}

	const query = searchQuery.trim().toLowerCase();
	if (query) {
		list = list.filter((product) => (product.name || '').toLowerCase().includes(query));
	}

	const sorter = SORTERS[sortKey];
	// slice() обязателен: sort() сортирует на месте и без копии
	// перемешал бы allProducts, уничтожив исходный порядок Маркета.
	return sorter ? list.slice().sort(sorter) : list;
}

function isFilterActive() {
	return activeCategory !== ALL_CATEGORIES || sortKey !== 'popular' || searchQuery.trim() !== '';
}

/** Русское склонение: 1 товар, 2 товара, 5 товаров, 11 товаров, 21 товар. */
function pluralize(count, [one, few, many]) {
	const mod100 = count % 100;
	if (mod100 >= 11 && mod100 <= 14) return many;

	const mod10 = count % 10;
	if (mod10 === 1) return one;
	if (mod10 >= 2 && mod10 <= 4) return few;
	return many;
}

function updateResultCount(shown) {
	const countEl = document.getElementById('resultCount');
	if (!countEl) return;

	const total = allProducts.length;
	const word = pluralize(shown, ['товар', 'товара', 'товаров']);

	countEl.textContent = shown === total ? `${total} ${word}` : `Найдено: ${shown} ${word} из ${total}`;
}

function updateResetButton() {
	const resetBtn = document.getElementById('resetFilters');
	if (resetBtn) resetBtn.hidden = !isFilterActive();
}

// --- Категории --------------------------------------------------------------

function renderFilters() {
	const filtersEl = document.getElementById('filters');
	if (!filtersEl) return;

	const counts = {};
	allProducts.forEach((product) => {
		const category = product.category || NO_CATEGORY;
		counts[category] = (counts[category] || 0) + 1;
	});

	const categories = [ALL_CATEGORIES, ...Object.keys(counts).sort((a, b) => a.localeCompare(b, 'ru'))];

	filtersEl.innerHTML = categories
		.map((category) => {
			const isActive = category === activeCategory;
			const count = category === ALL_CATEGORIES ? allProducts.length : counts[category];
			return `<button class="catalog__filter${isActive ? ' catalog__filter--active' : ''}" type="button" role="tab" aria-selected="${isActive}" data-category="${escapeHtml(category)}">${escapeHtml(category)}<span class="catalog__filter-count">${count}</span></button>`;
		})
		.join('');

	filtersEl.querySelectorAll('.catalog__filter').forEach((btn) => {
		btn.addEventListener('click', () => {
			activeCategory = btn.dataset.category;
			currentPage = 1;
			// Перерисовывать чипы целиком нельзя: сбросится позиция прокрутки.
			updateActiveChip();
			renderProducts();
		});
	});

	updateActiveChip();
	updateChipsAffordance();
}

function updateActiveChip() {
	document.querySelectorAll('.catalog__filter').forEach((btn) => {
		const isActive = btn.dataset.category === activeCategory;
		btn.classList.toggle('catalog__filter--active', isActive);
		btn.setAttribute('aria-selected', String(isActive));
	});
}

/**
 * Показывает стрелки и градиент затухания только тогда, когда список
 * категорий действительно уезжает за край, и только с той стороны,
 * с которой есть что прокручивать.
 */
let updateChipsAffordance = () => {};

function setupChipsScroller() {
	const filtersEl = document.getElementById('filters');
	const prevBtn = document.querySelector('.catalog__chips-nav--prev');
	const nextBtn = document.querySelector('.catalog__chips-nav--next');
	if (!filtersEl) return;

	const EDGE = 4; // допуск в пикселях на дробную прокрутку

	updateChipsAffordance = () => {
		const maxScroll = filtersEl.scrollWidth - filtersEl.clientWidth;
		const canScroll = maxScroll > EDGE;
		const atStart = filtersEl.scrollLeft <= EDGE;
		const atEnd = filtersEl.scrollLeft >= maxScroll - EDGE;

		// Обе стрелки остаются на месте всегда — тускнеют (см. :disabled в CSS),
		// когда ехать в эту сторону больше некуда, вместо того чтобы пропадать.
		if (prevBtn) prevBtn.disabled = !canScroll || atStart;
		if (nextBtn) nextBtn.disabled = !canScroll || atEnd;

		// Узкая маска-затухание только с той стороны, где чип действительно обрезается краем
		// контейнера — чтобы он плавно исчезал, а не обрезался вертикальной линией.
		filtersEl.classList.toggle('catalog__filters--fade-both', canScroll && !atStart && !atEnd);
		filtersEl.classList.toggle('catalog__filters--fade-end', canScroll && atStart);
		filtersEl.classList.toggle('catalog__filters--fade-start', canScroll && atEnd && !atStart);
	};

	const scrollByPage = (direction) => {
		filtersEl.scrollBy({ left: direction * Math.round(filtersEl.clientWidth * 0.7), behavior: 'smooth' });
	};

	if (prevBtn) prevBtn.addEventListener('click', () => scrollByPage(-1));
	if (nextBtn) nextBtn.addEventListener('click', () => scrollByPage(1));

	filtersEl.addEventListener('scroll', updateChipsAffordance, { passive: true });
	window.addEventListener('resize', updateChipsAffordance);

	// Чипы появляются после загрузки каталога — ловим изменение размеров.
	if (window.ResizeObserver) {
		new ResizeObserver(updateChipsAffordance).observe(filtersEl);
	}

	updateChipsAffordance();
}

// --- Сортировка -------------------------------------------------------------

function setupSortDropdown() {
	const wrapper = document.getElementById('sortDropdown');
	const btn = document.getElementById('sortBtn');
	const list = document.getElementById('sortList');
	const labelEl = document.getElementById('sortLabel');
	if (!wrapper || !btn || !list || !labelEl) return;

	list.innerHTML = SORT_OPTIONS.map(
		(option, index) =>
			`<li class="catalog__sort-option" role="option" id="sort-option-${index}" data-key="${option.key}" aria-selected="${option.key === sortKey}">${escapeHtml(option.label)}</li>`,
	).join('');

	const options = Array.from(list.querySelectorAll('.catalog__sort-option'));
	let focusedIndex = Math.max(0, SORT_OPTIONS.findIndex((option) => option.key === sortKey));

	const highlight = (index) => {
		focusedIndex = (index + options.length) % options.length;
		options.forEach((option, i) => option.classList.toggle('catalog__sort-option--focused', i === focusedIndex));
		list.setAttribute('aria-activedescendant', options[focusedIndex].id);
	};

	const close = () => {
		list.hidden = true;
		btn.setAttribute('aria-expanded', 'false');
		options.forEach((option) => option.classList.remove('catalog__sort-option--focused'));
	};

	const open = () => {
		list.hidden = false;
		btn.setAttribute('aria-expanded', 'true');
		highlight(SORT_OPTIONS.findIndex((option) => option.key === sortKey));
	};

	const choose = (key) => {
		sortKey = key;
		labelEl.textContent = SORT_OPTIONS.find((option) => option.key === key).label;
		options.forEach((option) => option.setAttribute('aria-selected', String(option.dataset.key === key)));
		currentPage = 1;
		close();
		renderProducts();
		btn.focus();
	};

	btn.addEventListener('click', () => (list.hidden ? open() : close()));
	options.forEach((option) => option.addEventListener('click', () => choose(option.dataset.key)));

	/**
	 * Фокус остаётся на кнопке и когда список раскрыт, поэтому вся клавиатура
	 * обрабатывается здесь. Enter и Пробел при закрытом списке не перехватываем —
	 * браузер сам превратит их в click и откроет список.
	 */
	btn.addEventListener('keydown', (event) => {
		if (list.hidden) {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				open();
			}
			return;
		}

		switch (event.key) {
			case 'Escape':
				event.preventDefault();
				close();
				break;
			case 'ArrowDown':
				event.preventDefault();
				highlight(focusedIndex + 1);
				break;
			case 'ArrowUp':
				event.preventDefault();
				highlight(focusedIndex - 1);
				break;
			case 'Enter':
			case ' ':
				event.preventDefault();
				choose(options[focusedIndex].dataset.key);
				break;
			case 'Tab':
				close();
				break;
			default:
				break;
		}
	});

	document.addEventListener('click', (event) => {
		if (!list.hidden && !wrapper.contains(event.target)) close();
	});

	// Начальная подпись — на случай, если стартовая сортировка изменится.
	labelEl.textContent = SORT_OPTIONS.find((option) => option.key === sortKey).label;
}

// --- Фильтр по цене (двойной слайдер noUiSlider) --------------------------------

function setupPriceFilter() {
	const sliderEl = document.getElementById('priceSlider');
	const minLabel = document.getElementById('priceMinLabel');
	const maxLabel = document.getElementById('priceMaxLabel');
	if (!sliderEl || !window.noUiSlider) return;

	noUiSlider.create(sliderEl, {
		start: [0, 0],
		connect: true,
		range: { min: 0, max: 1 },
		step: 1,
		behaviour: 'drag-tap',
	});

	priceSlider = sliderEl.noUiSlider;

	const formatLabel = (value) => `${Math.round(Number(value)).toLocaleString('ru-RU')} ₽`;

	// 'update' срабатывает постоянно во время перетаскивания — только подпись чисел,
	// без перерисовки сетки товаров.
	priceSlider.on('update', (values) => {
		if (minLabel) minLabel.textContent = formatLabel(values[0]);
		if (maxLabel) maxLabel.textContent = formatLabel(values[1]);
	});

	// 'change' срабатывает, когда ползунок отпущен — вот тут уже перерисовываем каталог.
	priceSlider.on('change', (values) => {
		const min = Math.round(Number(values[0]));
		const max = Math.round(Number(values[1]));
		// Если ползунам не сдвигали от края — фильтр по этой границе не нужен.
		priceMin = min <= priceRangeMin ? null : min;
		priceMax = max >= priceRangeMax ? null : max;
		currentPage = 1;
		renderProducts();
	});
}

/**
 * Границы слайдера считаются по реальным ценам в каталоге и вызывается один раз,
 * сразу после загрузки товаров. Сбрасывает выбранный диапазон 0..max.
 */
function updatePriceRangeFromProducts() {
	if (!priceSlider || allProducts.length === 0) return;

	const prices = allProducts.map((product) => product.price).filter((price) => Number.isFinite(price));
	if (prices.length === 0) return;

	priceRangeMin = Math.floor(Math.min(...prices) / 10) * 10;
	priceRangeMax = Math.max(priceRangeMin + 1, Math.ceil(Math.max(...prices) / 10) * 10);

	priceSlider.updateOptions(
		{
			range: { min: priceRangeMin, max: priceRangeMax },
			start: [priceRangeMin, priceRangeMax],
		},
		true,
	);
}

// --- Поиск по названию товара ----------------------------------------------------

function setupSearch() {
	const input = document.getElementById('searchInput');
	const clearBtn = document.getElementById('searchClear');
	if (!input) return;

	let debounceTimer = null;

	const applySearch = () => {
		searchQuery = input.value;
		if (clearBtn) clearBtn.hidden = searchQuery.trim() === '';
		currentPage = 1;
		renderProducts();
	};

	input.addEventListener('input', () => {
		// Небольшая задержка, чтобы не перерисовывать всю сетку на каждое нажатие клавиши.
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(applySearch, 200);
	});

	if (clearBtn) {
		clearBtn.addEventListener('click', () => {
			input.value = '';
			clearTimeout(debounceTimer);
			applySearch();
			input.focus();
		});
	}
}

// --- Сброс фильтров ---------------------------------------------------------

function resetFilters() {
	activeCategory = ALL_CATEGORIES;
	sortKey = 'popular';
	priceMin = null;
	priceMax = null;
	searchQuery = '';
	currentPage = 1;

	if (priceSlider) priceSlider.set([priceRangeMin, priceRangeMax]);

	const searchInput = document.getElementById('searchInput');
	if (searchInput) searchInput.value = '';
	const searchClear = document.getElementById('searchClear');
	if (searchClear) searchClear.hidden = true;

	const labelEl = document.getElementById('sortLabel');
	if (labelEl) labelEl.textContent = SORT_OPTIONS[0].label;

	document.querySelectorAll('.catalog__sort-option').forEach((option) => {
		option.setAttribute('aria-selected', String(option.dataset.key === 'popular'));
	});

	const filtersEl = document.getElementById('filters');
	if (filtersEl) filtersEl.scrollTo({ left: 0, behavior: 'smooth' });

	updateActiveChip();
	renderProducts();
}

function setupResetButton() {
	const resetBtn = document.getElementById('resetFilters');
	if (resetBtn) resetBtn.addEventListener('click', resetFilters);

	// Кнопка «Сбросить» внутри пустого состояния появляется динамически.
	const gridEl = document.getElementById('products');
	if (gridEl) {
		gridEl.addEventListener('click', (event) => {
			if (event.target.closest('.catalog__empty-reset')) resetFilters();
		});
	}
}

// --- Отрисовка каталога -----------------------------------------------------

function renderProducts() {
	const gridEl = document.getElementById('products');
	if (!gridEl) return;

	const visible = getVisibleProducts();

	const totalPages = Math.max(1, Math.ceil(visible.length / PRODUCTS_PER_PAGE));
	currentPage = Math.min(currentPage, totalPages);

	const start = (currentPage - 1) * PRODUCTS_PER_PAGE;
	const pageItems = visible.slice(start, start + PRODUCTS_PER_PAGE);

	updateResultCount(visible.length);
	updateResetButton();

	gridEl.innerHTML = '';

	if (pageItems.length === 0) {
		gridEl.innerHTML = `
			<div class="catalog__empty">
				<p>Под эти условия ничего не подошло.</p>
				<button type="button" class="catalog__empty-reset">Сбросить фильтры</button>
			</div>`;
		renderPagination(1);
		return;
	}

	pageItems.forEach((product, index) => {
		const href = safeUrl(product.url);
		const card = document.createElement(href ? 'a' : 'div');
		card.className = 'product-card';

		if (href) {
			card.href = href;
			card.target = '_blank';
			card.rel = 'noopener noreferrer';
		}

		let discountBadge = '';
		let oldPriceHtml = '';
		if (product.oldPrice && product.price && product.oldPrice > product.price) {
			const percent = Math.round((1 - product.price / product.oldPrice) * 100);
			discountBadge = `<span class="product-card__badge">-${percent}%</span>`;
			oldPriceHtml = `<span class="product-card__price product-card__price--old">${Number(product.oldPrice).toLocaleString('ru-RU')} ₽</span>`;
		}

		card.setAttribute('data-aos', 'fade-up');
		card.setAttribute('data-aos-delay', String((index % 6) * 70));

		const name = escapeHtml(product.name);
		const image = safeUrl(product.image);

		card.innerHTML = `
			${discountBadge}
			<img class="product-card__image" src="${image}" alt="${name}" loading="lazy">
			<div class="product-card__body">
				<span class="product-card__source">${escapeHtml(product.source)}</span>
				<span class="product-card__name">${name}</span>
				<div class="product-card__price-row">
					<span class="product-card__price">${Number(product.price).toLocaleString('ru-RU')} ₽</span>
					${oldPriceHtml}
				</div>
				${href ? '<span class="product-card__link">Смотреть товар →</span>' : ''}
			</div>
		`;

		gridEl.appendChild(card);
	});

	renderPagination(totalPages);

	// AOS не видит динамически добавленные элементы без пересчёта
	if (window.AOS) {
		AOS.refreshHard();
	}
}

function renderPagination(totalPages) {
	const paginationEl = document.getElementById('pagination');
	if (!paginationEl) return;

	if (totalPages <= 1) {
		paginationEl.innerHTML = '';
		return;
	}

	// --- Собираем список того, что показывать: номера страниц и '...' ---
	const SIBLINGS = 1; // сколько соседних страниц показывать слева/справа от текущей
	const pages = [];

	pages.push(1);

	const rangeStart = Math.max(2, currentPage - SIBLINGS);
	const rangeEnd = Math.min(totalPages - 1, currentPage + SIBLINGS);

	if (rangeStart > 2) {
		pages.push('...');
	}

	for (let i = rangeStart; i <= rangeEnd; i++) {
		pages.push(i);
	}

	if (rangeEnd < totalPages - 1) {
		pages.push('...');
	}

	if (totalPages > 1) {
		pages.push(totalPages);
	}

	// --- Рендерим: стрелка назад, номера/многоточия, стрелка вперёд ---
	let buttons = `<button class="catalog__page-btn catalog__page-btn--nav" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''} aria-label="Предыдущая страница">‹</button>`;

	buttons += pages
		.map((page) => {
			if (page === '...') {
				return `<span class="catalog__page-ellipsis">…</span>`;
			}
			return `<button class="catalog__page-btn ${page === currentPage ? 'catalog__page-btn--active' : ''}" data-page="${page}">${page}</button>`;
		})
		.join('');

	buttons += `<button class="catalog__page-btn catalog__page-btn--nav" data-page="${currentPage + 1}" ${currentPage === totalPages ? 'disabled' : ''} aria-label="Следующая страница">›</button>`;

	paginationEl.innerHTML = buttons;

	paginationEl.querySelectorAll('.catalog__page-btn:not([disabled])').forEach((btn) => {
		btn.addEventListener('click', () => {
			currentPage = Number(btn.dataset.page);
			renderProducts();
			document.getElementById('catalog').scrollIntoView({ behavior: 'smooth' });
		});
	});
}

// --- Ссылка из FAQ на блок контактов -------------------------------------------

function setupFaqMoreLink() {
	const link = document.getElementById('faqMoreLink');
	const title = document.getElementById('contactTitle');
	if (!link || !title) return;

	link.addEventListener('click', () => {
		// Сбрасываем и вызываем reflow, чтобы анимация могла запуститься заново,
		// если по ссылке кликают несколько раз подряд.
		title.classList.remove('contact__title--pulse');
		void title.offsetWidth;
		title.classList.add('contact__title--pulse');
	});

	title.addEventListener('animationend', (event) => {
		// В CSS у .contact__title--pulse одна анимация — contactTitleBounce.
		// Раньше здесь ждали contactTitleBorderBlink, которой в стилях нет,
		// и класс после первого клика оставался на элементе навсегда.
		if (event.animationName === 'contactTitleBounce') {
			title.classList.remove('contact__title--pulse');
		}
	});
}

// --- Форма обратной связи --------------------------------------------------

function setupContactForm() {
	const form = document.getElementById('contactForm');
	if (!form) return; // секции с формой на странице нет — просто выходим, ничего не ломаем

	const note = document.getElementById('formNote');
	const submitBtn = form.querySelector('.contact__submit');

	const setNote = (text, state) => {
		if (!note) return;
		note.textContent = text;
		note.className = `contact__form-note${state ? ` contact__form-note--${state}` : ''}`;
	};

	/**
	 * Обращаемся к полям через form.elements: у самой формы есть собственное
	 * свойство name, поэтому form.name вернёт атрибут формы, а не поле ввода.
	 */
	const field = (fieldName) => form.elements.namedItem(fieldName);
	const valueOf = (fieldName) => (field(fieldName) ? field(fieldName).value : '');

	form.addEventListener('submit', async (event) => {
		event.preventDefault();

		setNote('Отправляем…', 'pending');
		if (submitBtn) submitBtn.disabled = true;

		try {
			const response = await fetch(`${API_BASE}/api/contact`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
				body: JSON.stringify({
					name: valueOf('name'),
					contact: valueOf('contact'),
					message: valueOf('message'),
					website: valueOf('website'),
					consent: field('consent') ? field('consent').checked : false,
				}),
			});

			// 204 приходит на заявку, пойманную honeypot-ловушкой.
			// Для живого пользователя этот случай недостижим.
			if (response.status === 204) {
				setNote('Сообщение отправлено. Мы ответим в ближайшее время.', 'ok');
				form.reset();
				return;
			}

			const data = await response.json().catch(() => ({}));

			if (response.ok) {
				setNote(data.message || 'Сообщение отправлено. Мы ответим в ближайшее время.', 'ok');
				form.reset();
				return;
			}

			// Сервер вернул ошибки по полям — показываем первую, она понятнее общей.
			const firstFieldError = data.fields ? Object.values(data.fields)[0] : null;
			setNote(firstFieldError || data.error || 'Не получилось отправить сообщение.', 'error');
		} catch (error) {
			console.error('Ошибка при отправке формы:', error);
			setNote('Нет связи с сервером. Попробуй позже или напиши нам в Telegram.', 'error');
		} finally {
			if (submitBtn) submitBtn.disabled = false;
		}
	});
}

// --- FAQ-аккордеон ---------------------------------------------------------

function setupFAQ() {
	const items = document.querySelectorAll('.faq__item');

	items.forEach((item) => {
		const question = item.querySelector('.faq__question');
		const answer = item.querySelector('.faq__answer');

		question.addEventListener('click', () => {
			const isOpen = item.classList.contains('faq__item--open');

			items.forEach((other) => {
				other.classList.remove('faq__item--open');
				other.querySelector('.faq__answer').style.maxHeight = null;
			});

			if (!isOpen) {
				item.classList.add('faq__item--open');
				answer.style.maxHeight = answer.scrollHeight + 'px';
			}
		});
	});
}

// --- Слайдер отзывов на Swiper ---------------------------------------------

function setupReviewsSlider() {
	const container = document.getElementById('reviewsSwiper');
	if (!container || !window.Swiper) return;

	// Стрелки и точки — существующая разметка со своим оформлением.
	// Swiper управляет ими через navigation/pagination, поэтому CSS менять не нужно.
	new Swiper(container, {
		slidesPerView: 1.15,
		spaceBetween: 20,
		grabCursor: true,
		watchOverflow: true,
		keyboard: { enabled: true },
		a11y: {
			enabled: true,
			prevSlideMessage: 'Предыдущий отзыв',
			nextSlideMessage: 'Следующий отзыв',
		},
		navigation: {
			prevEl: '#reviewsPrev',
			nextEl: '#reviewsNext',
		},
		pagination: {
			el: '#reviewsDots',
			clickable: true,
			bulletClass: 'reviews__dot',
			bulletActiveClass: 'reviews__dot--active',
		},
		// Совпадает с прежними брейкпоинтами вёрстки: 3 карточки / 2 / 1 с «подглядыванием».
		breakpoints: {
			641: { slidesPerView: 2 },
			901: { slidesPerView: 3 },
		},
	});
}

// --- Бургер-меню для мобильной вёрстки шапки -------------------------------

function setupBurgerMenu() {
	const burgerBtn = document.getElementById('burgerBtn');
	const mobileNav = document.getElementById('mobileNav');
	if (!burgerBtn || !mobileNav) return;

	const closeMenu = () => {
		burgerBtn.setAttribute('aria-expanded', 'false');
		mobileNav.classList.remove('is-open');
		document.body.style.overflow = '';
	};

	const openMenu = () => {
		burgerBtn.setAttribute('aria-expanded', 'true');
		mobileNav.classList.add('is-open');
		document.body.style.overflow = 'hidden';
	};

	burgerBtn.addEventListener('click', () => {
		const isOpen = mobileNav.classList.contains('is-open');
		isOpen ? closeMenu() : openMenu();
	});

	// Закрываем меню при клике на любую ссылку внутри него
	mobileNav.querySelectorAll('a').forEach((link) => {
		link.addEventListener('click', closeMenu);
	});

	// Закрываем меню, если экран расширили обратно до десктопа
	window.addEventListener('resize', () => {
		if (window.innerWidth > 860) closeMenu();
	});
}

// --- Кнопка «наверх» -------------------------------------------------------

function setupBackToTop() {
	const btn = document.getElementById('backToTop');
	if (!btn) return;

	const toggle = () => {
		if (window.scrollY > 480) {
			btn.classList.add('is-visible');
		} else {
			btn.classList.remove('is-visible');
		}
	};

	window.addEventListener('scroll', toggle, { passive: true });
	toggle();

	btn.addEventListener('click', () => {
		window.scrollTo({ top: 0, behavior: 'smooth' });
	});
}

// --- Запуск ----------------------------------------------------------------

setupChipsScroller();
setupSortDropdown();
setupPriceFilter();
setupSearch();
setupResetButton();

loadProducts();
setupContactForm();
setupFAQ();
setupFaqMoreLink();
setupBackToTop();
setupBurgerMenu();
setupReviewsSlider();

// --- Анимации при скролле (AOS) ---
if (window.AOS) {
	AOS.init({
		duration: 700,
		easing: 'ease-out-cubic',
		once: true,
		offset: 60,
	});
}

// --- Иконки Lucide (подключены в index.html через CDN) ---
if (window.lucide) {
	lucide.createIcons();
} else {
	document.addEventListener('DOMContentLoaded', () => {
		if (window.lucide) lucide.createIcons();
	});
}
