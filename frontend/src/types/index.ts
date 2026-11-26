export interface MacroSummary {
  label: string
  consumed: number
  goal: number
  unit: 'g' | 'kcal'
}

export interface WorkoutSummary {
  title: string
  exerciseCount: number
  durationMinutes: number
}

export interface Exercise {
  id: string
  name: string
  muscle_group: string
  name_es?: string | null
  category: string
  description?: string | null
  muscles: string[]
  muscles_secondary: string[]
  equipment: string[]
  aliases: string[]
  images: string[]
  muscle_images: string[]
  is_custom?: boolean // <-- AJOUT
  guide?: ExerciseGuide | null
}

export interface ExerciseGuide {
  setup: string[]
  cues: string[]
  breathing: string
  mistakes: string[]
  tip: string
  safety: string
}

export interface ExerciseListResponse {
  items: Exercise[]
  total: number
  page: number
  limit: number
}

export type FitnessGoal = 'Lose Weight' | 'Strength' | 'Hypertrophy'

export type PremiumPlan = 'annual' | 'monthly'

export interface UserOnboardingFormData {
  firstName: string
  lastName: string
  email: string
  password: string
  confirmPassword: string
  agreedToTerms: boolean
  birthDate: string
  gender: 'Male' | 'Female' | 'Other'
  weight: string
  height: string
  mainGoal: FitnessGoal
}

export interface UserProfile {
  id?: string
  email: string
  name: string
  surname: string
  is_premium?: boolean
  premium_plan?: PremiumPlan | string | null
  premium_started_at?: string | null
  premium_expires_at?: string | null
  premium_cancel_at_period_end?: boolean
  birthDate?: string
  age?: number
  gender?: string
  weight?: number
  height?: number
  objective?: FitnessGoal
  calorie_goal?: number
}

// <-- AJOUT DU PAYLOAD CUSTOM EXERCISE
export interface CustomExercisePayload {
  name: string
  muscle_group: string
  muscles?: string[]
  muscles_secondary?: string[]
  equipment?: string[]
  description?: string
};

export interface ChatExercise {
  id: string
  name: string
  is_cardio?: boolean
}

export interface ChatMeal {
  key: string
  name: string
  meal_type: string
  calories: number
  proteins_g: number
  carbs_g: number
  fats_g: number
  ingredients: import('../services/api').MealIngredient[]
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  exercises: ChatExercise[]
  meals?: ChatMeal[]
  created_at: string
}

export interface ChatQuota {
  used: number
  limit: number
  is_premium: boolean
}

export interface ChatReply {
  conversation_id: string
  message: ChatMessage
  quota: ChatQuota
}

export interface ConversationSummary {
  id: string
  title: string
  updated_at: string
}

export interface ConversationDetail extends ConversationSummary {
  messages: ChatMessage[]
}
