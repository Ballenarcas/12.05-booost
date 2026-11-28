-- Removes everything community_mock.sql created: the mock members (@mock.booost.test), their posts,
-- likes, comments and follows, including anyone's likes, comments and follows that point at them.

BEGIN;

CREATE TEMP TABLE mock_members ON COMMIT DROP AS
    SELECT id FROM public.users WHERE email LIKE '%@mock.booost.test';

DELETE FROM public.social_post_likes
WHERE user_id IN (SELECT id FROM mock_members)
   OR post_id IN (SELECT id FROM public.social_posts WHERE user_id IN (SELECT id FROM mock_members));

DELETE FROM public.social_comments
WHERE user_id IN (SELECT id FROM mock_members)
   OR post_id IN (SELECT id FROM public.social_posts WHERE user_id IN (SELECT id FROM mock_members));

DELETE FROM public.social_follows
WHERE follower_id IN (SELECT id FROM mock_members) OR followee_id IN (SELECT id FROM mock_members);

DELETE FROM public.social_blocks
WHERE blocker_id IN (SELECT id FROM mock_members) OR blocked_id IN (SELECT id FROM mock_members);

DELETE FROM public.social_posts WHERE user_id IN (SELECT id FROM mock_members);

DELETE FROM public.users WHERE id IN (SELECT id FROM mock_members);

COMMIT;
