import type { Pool } from "pg";

export async function seedCorrectAnswer(pool: Pool, attemptId: string, packageId: string): Promise<void> {
  const question = await pool.query<{id:string}>(
    `INSERT INTO quiz_questions (quiz_package_id,question_id,prompt,options,correct_option,sort_order)
     VALUES ($1,'score-question','Score fixture','["correct","wrong"]',0,0)
     ON CONFLICT (quiz_package_id,question_id) DO UPDATE SET prompt=EXCLUDED.prompt RETURNING id`, [packageId]);
  await pool.query(`INSERT INTO quiz_answers (quiz_attempt_id,quiz_question_id,selected_option,is_correct)
    VALUES ($1,$2,0,true)`, [attemptId,question.rows[0]!.id]);
}
