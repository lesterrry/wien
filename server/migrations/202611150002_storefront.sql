-- Marketing multipliers are not request quotas. The metered AI budget must be
-- configured and enforced before paid checkout is enabled.
ALTER TABLE plans
    ADD COLUMN ai_usage_multiplier integer CHECK (ai_usage_multiplier > 0),
    ADD COLUMN name_ru text,
    ADD COLUMN description_ru text,
    ADD COLUMN features_ru text[];

UPDATE plans SET name_ru='Бесплатный',
    description_ru='Попробуйте помощника ИИ перед выбором платного тарифа.',
    features_ru=ARRAY['10 пробных текстовых запросов однократно', 'Редактор музыки и сохранение проектов', 'Без аудиовложений']
WHERE id='free';
UPDATE plans SET ai_usage_multiplier=1,
    description='A base allowance of AI usage for creating and editing music.',
    features=ARRAY['Base AI usage allowance', 'Text and audio requests', 'One month of access; renew manually'],
    name_ru='Плюс', description_ru='Базовый объём ИИ для создания и редактирования музыки.',
    features_ru=ARRAY['Базовый объём использования ИИ', 'Текстовые запросы и аудиовложения', 'Один месяц доступа, ручное продление']
WHERE id='plus';
UPDATE plans SET ai_usage_multiplier=20,
    description='20 times the AI usage allowance of Plus.',
    features=ARRAY['20× the AI usage allowance of Plus', 'Text and audio requests', 'One month of access; renew manually'],
    name_ru='Про', description_ru='В 20 раз больше объёма ИИ, чем в тарифе Плюс.',
    features_ru=ARRAY['Объём использования ИИ ×20 относительно Плюс', 'Текстовые запросы и аудиовложения', 'Один месяц доступа, ручное продление']
WHERE id='pro';
UPDATE plans SET ai_usage_multiplier=100,
    description='100 times the AI usage allowance of Plus.',
    features=ARRAY['100× the AI usage allowance of Plus', 'Text and audio requests', 'One month of access; renew manually'],
    name_ru='Ультра', description_ru='В 100 раз больше объёма ИИ, чем в тарифе Плюс.',
    features_ru=ARRAY['Объём использования ИИ ×100 относительно Плюс', 'Текстовые запросы и аудиовложения', 'Один месяц доступа, ручное продление']
WHERE id='ultra';

-- Only public seller information. Never put payment credentials in this table.
CREATE TABLE storefront (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    seller_name text NOT NULL,
    seller_inn text NOT NULL CHECK (seller_inn ~ '^[0-9]{12}$'),
    seller_city text NOT NULL,
    support_email text NOT NULL CHECK (support_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
    support_phone text,
    accounts_location text NOT NULL,
    document_version text NOT NULL,
    documents_published boolean NOT NULL DEFAULT false,
    renewal_mode text NOT NULL DEFAULT 'manual' CHECK (renewal_mode='manual'),
    ai_usage_policy text NOT NULL
);
INSERT INTO storefront (seller_name,seller_inn,seller_city,support_email,accounts_location,document_version,ai_usage_policy)
VALUES ('Насибуллин Айдар Амирович','774313113437','Москва','mail@aydar.media',
        'Российская Федерация','2026-11-15',
        'Объём использования ИИ зависит от сложности запроса, размера контекста и обработки аудио. Тарифы сравниваются по объёму ИИ, а не по фиксированному числу запросов. Про включает в 20 раз, а Ультра — в 100 раз больше объёма, чем Плюс.');
