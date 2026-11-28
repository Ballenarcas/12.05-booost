export interface Member {
  id: string
  username: string
  name: string
  avatar_url: string | null
  is_private: boolean
}

export type CardType = 'workout' | 'pr' | 'nutrition_streak'

export interface WorkoutCardData {
  name: string
  duration_seconds: number
  exercise_count: number
  completed_sets: number
  total_volume_kg: number
  completed_at: string
}

export interface PrCardData {
  exercise_name: string
  weight_kg: number
  reps: number
  previous_best_kg: number
}

export interface StreakCardData {
  days: number
}

/** What the browser may send: a pointer to the author's own data, never the numbers. */
export interface CardRef {
  type: CardType
  workout_id?: string
  exercise_id?: string
}

export interface Post {
  id: string
  author: Member
  body: string
  image_urls: string[]
  card_type: CardType | null
  card: WorkoutCardData | PrCardData | StreakCardData | null
  like_count: number
  comment_count: number
  liked_by_me: boolean
  can_delete: boolean
  created_at: string
}

export interface Comment {
  id: string
  author: Member
  body: string
  can_delete: boolean
  created_at: string
}

export interface FeedPage {
  items: Post[]
  next_cursor: string | null
}

export type FeedMode = 'following' | 'discover'

export interface MemberProfile {
  user: Member
  followers: number
  following: number
  posts_visible: boolean
  follow_state: 'none' | 'pending' | 'following'
  follows_you: boolean
  is_me: boolean
}

export interface SocialMe {
  id: string
  joined: boolean
  username: string | null
  name: string
  is_private: boolean
  avatar_url: string | null
  followers: number
  following: number
  pending_requests: number
  following_preview: Member[]
}

export interface Attachables {
  workouts: {
    workout_id: string
    name: string
    completed_at: string
    prs: (PrCardData & { exercise_id: string })[]
  }[]
  streak_days: number
  streak_to_share: number
}
