export interface EmailProvider {
  sendEmail(to: string, subject: string, text: string, fromName?: string): Promise<{ delivered: boolean; providerMessageId?: string; errorDetails?: string }>;
}

import { Resend } from 'resend';

export class ResendProvider implements EmailProvider {
  private resend: Resend;
  private from: string;

  constructor(apiKey: string, from: string) {
    this.resend = new Resend(apiKey);
    this.from = from;
  }

  async sendEmail(to: string, subject: string, text: string, fromName?: string): Promise<{ delivered: boolean; providerMessageId?: string; errorDetails?: string }> {
    try {
      const result = await this.resend.emails.send({
        from: `${fromName || 'GymOS'} <${this.from}>`,
        to,
        subject,
        text,
      });
      if (result.error) {
        return { delivered: false, errorDetails: result.error.message };
      }
      return { delivered: true, providerMessageId: result.data?.id };
    } catch (err: any) {
      return { delivered: false, errorDetails: err.message };
    }
  }
}
