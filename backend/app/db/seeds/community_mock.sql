-- Mock Community data, to try the "For you" feed by hand. NOT a migration.
--
-- Every mock member has an email ending in @mock.booost.test and a password that is not a
-- bcrypt hash, so none of them can sign in. community_mock_cleanup.sql removes all of it.
-- Running this twice is safe: it does nothing if the mock members already exist.
--
-- What it makes:
--   8 fictional members (one private), 24 posts spread over the last 6 days, likes and comments
--   so some posts are clearly more popular, and the test account (testan@gmail.com, if it exists)
--   following three of them, so "Following" has content and "For you" shows the follow lift.

BEGIN;

INSERT INTO public.users (id, email, password, "Name", "Surname", username, is_private)
SELECT v.id::uuid, v.email, '!mock-account-cannot-sign-in', v.name, v.surname, v.username, v.private
FROM (VALUES
    ('0a000000-0000-4000-8000-000000000001', 'lucia@mock.booost.test',  'Lucía',  'Martín',  'lucia_lifts',   false),
    ('0a000000-0000-4000-8000-000000000002', 'marcos@mock.booost.test', 'Marcos', 'Vidal',   'marcos_runs',   false),
    ('0a000000-0000-4000-8000-000000000003', 'irene@mock.booost.test',  'Irene',  'Soler',   'irene_fit',     false),
    ('0a000000-0000-4000-8000-000000000004', 'david@mock.booost.test',  'David',  'Ortega',  'david_squats',  false),
    ('0a000000-0000-4000-8000-000000000005', 'nuria@mock.booost.test',  'Nuria',  'Campos',  'nuria_meals',   false),
    ('0a000000-0000-4000-8000-000000000006', 'pablo@mock.booost.test',  'Pablo',  'Ferrer',  'pablo_pr',      false),
    ('0a000000-0000-4000-8000-000000000007', 'sara@mock.booost.test',   'Sara',   'Lozano',  'sara_strength', false),
    ('0a000000-0000-4000-8000-000000000008', 'hugo@mock.booost.test',   'Hugo',   'Navarro', 'hugo_private',  true)
) AS v(id, email, name, surname, username, private)
WHERE NOT EXISTS (SELECT 1 FROM public.users WHERE email LIKE '%@mock.booost.test');

-- Posts: (member, minutes ago, text, card type, card). Popularity comes from the likes below.
INSERT INTO public.social_posts (user_id, body, card_type, card, author_private, created_at)
SELECT m.id, p.body, p.card_type, p.card::jsonb, m.is_private, now() - make_interval(mins => p.minutes)
FROM (VALUES
    (1,   12, 'Primera sesión de la semana hecha. Las piernas no me lo van a perdonar mañana 🦵', NULL, NULL),
    (2,   35, '10 km por debajo de 50 minutos por fin 🏃‍♂️', NULL, NULL),
    (3,   70, '¿Alguien más entrena a las 6 de la mañana? Necesito compañía para no rendirme', NULL, NULL),
    (4,  150, 'Sentadilla con técnica limpia > sentadilla con más peso. Hoy he bajado 10 kg y me siento mejor.', NULL, NULL),
    (5,  200, 'Meal prep del domingo: arroz, pollo al curry y verduras asadas para toda la semana', NULL, NULL),
    (6,  260, '', 'workout', '{"name": "Push day", "duration_seconds": 3900, "exercise_count": 6, "completed_sets": 22, "total_volume_kg": 8450}'),
    (7,  320, 'Récord personal en peso muerto. Llevaba tres meses estancada 💪', NULL, NULL),
    (1,  420, 'Consejo que me habría gustado oír antes: duerme 8 horas antes de tocar la creatina.', NULL, NULL),
    (8,  480, 'Este post es privado: solo lo ven mis seguidores.', NULL, NULL),
    (2,  600, 'Rodaje suave de recuperación, 6 km. Escuchar al cuerpo también es entrenar.', NULL, NULL),
    (3,  720, '', 'nutrition_streak', '{"days": 21}'),
    (4,  900, '¿Rutina full body o torso/pierna para 3 días por semana? Leo opiniones 👇', NULL, NULL),
    (5, 1100, 'Desayuno alto en proteína sin batidos: tortilla de claras, avena y fruta.', NULL, NULL),
    (6, 1400, 'Hoy toca descanso activo: paseo largo y estiramientos.', NULL, NULL),
    (7, 1700, '', 'workout', '{"name": "Pull day", "duration_seconds": 3300, "exercise_count": 5, "completed_sets": 18, "total_volume_kg": 6120}'),
    (1, 2100, 'Un mes usando BOOOST y por fin entiendo mis macros 📊', NULL, NULL),
    (2, 2600, 'Media maratón en 6 semanas. ¿Algún plan que os haya funcionado?', NULL, NULL),
    (3, 3200, 'Clase de spinning + core. Destrozada pero feliz.', NULL, NULL),
    (4, 3900, 'Pequeño recordatorio: el progreso no es lineal.', NULL, NULL),
    (5, 4700, '', 'nutrition_streak', '{"days": 7}'),
    (6, 5600, 'Banca 100 kg por primera vez 🎉', NULL, NULL),
    (7, 6500, 'Domingo de pierna. Nadie me para.', NULL, NULL),
    (1, 7400, 'Probando el escáner de comidas con mi plato de pasta. Más preciso de lo que esperaba.', NULL, NULL),
    (2, 8600, 'Semana de descarga terminada, a por el siguiente bloque.', NULL, NULL)
) AS p(member, minutes, body, card_type, card)
JOIN public.users m ON m.id = ('0a000000-0000-4000-8000-00000000000' || p.member)::uuid
WHERE NOT EXISTS (SELECT 1 FROM public.social_posts sp JOIN public.users u ON u.id = sp.user_id
                  WHERE u.email LIKE '%@mock.booost.test');

-- Likes: every post gets a few, and some posts get many, so the ranking has something to rank.
-- The like counters on social_posts are kept by the database's own triggers.
INSERT INTO public.social_post_likes (post_id, user_id)
SELECT sp.id, liker.id
FROM public.social_posts sp
JOIN public.users author ON author.id = sp.user_id AND author.email LIKE '%@mock.booost.test'
JOIN public.users liker ON liker.email LIKE '%@mock.booost.test' AND liker.id <> sp.user_id
WHERE (abs(hashtext(sp.body || liker.email)) % 10) < CASE
        WHEN sp.body LIKE 'Récord%' OR sp.body LIKE 'Banca%' OR sp.body LIKE '10 km%' THEN 10
        WHEN sp.card_type IS NOT NULL OR sp.body LIKE '%?%' THEN 6
        ELSE 3 END
ON CONFLICT DO NOTHING;

-- Comments on a handful of posts, so comments weigh in too.
INSERT INTO public.social_comments (post_id, user_id, body)
SELECT sp.id, c.member_id, c.body
FROM (VALUES
    ('Récord%', '0a000000-0000-4000-8000-000000000001'::uuid, '¡Enhorabuena! Ese estancamiento era real.'),
    ('Récord%', '0a000000-0000-4000-8000-000000000004'::uuid, 'Brutal 🔥 ¿Cuánto has levantado?'),
    ('Récord%', '0a000000-0000-4000-8000-000000000006'::uuid, 'Las semanas de descarga funcionan.'),
    ('¿Rutina full body%', '0a000000-0000-4000-8000-000000000003'::uuid, 'Full body si tienes poco tiempo, sin duda.'),
    ('¿Rutina full body%', '0a000000-0000-4000-8000-000000000007'::uuid, 'Torso/pierna me fue mejor para ganar fuerza.'),
    ('¿Alguien más entrena%', '0a000000-0000-4000-8000-000000000002'::uuid, '¡Yo! A las 6:15 en el parque.'),
    ('Banca 100 kg%', '0a000000-0000-4000-8000-000000000007'::uuid, '¡Bienvenido al club de los 100!'),
    ('Media maratón%', '0a000000-0000-4000-8000-000000000005'::uuid, 'Tres rodajes suaves y uno largo por semana.')
) AS c(pattern, member_id, body)
JOIN public.social_posts sp ON sp.body LIKE c.pattern
JOIN public.users author ON author.id = sp.user_id AND author.email LIKE '%@mock.booost.test'
WHERE NOT EXISTS (SELECT 1 FROM public.social_comments sc WHERE sc.post_id = sp.id AND sc.user_id = c.member_id);

-- Mock members follow each other a little, and the test account follows three of them.
INSERT INTO public.social_follows (follower_id, followee_id, status)
SELECT f.follower::uuid, f.followee::uuid, 'accepted'
FROM (VALUES
    ('0a000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-000000000007'),
    ('0a000000-0000-4000-8000-000000000002', '0a000000-0000-4000-8000-000000000003'),
    ('0a000000-0000-4000-8000-000000000006', '0a000000-0000-4000-8000-000000000004')
) AS f(follower, followee)
ON CONFLICT DO NOTHING;

INSERT INTO public.social_follows (follower_id, followee_id, status)
SELECT me.id, m.id, 'accepted'
FROM public.users me
JOIN public.users m ON m.email IN ('lucia@mock.booost.test', 'marcos@mock.booost.test', 'nuria@mock.booost.test')
WHERE me.email = 'testan@gmail.com' AND me.username IS NOT NULL
ON CONFLICT DO NOTHING;

COMMIT;
