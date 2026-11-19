const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail', 
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const sendApplicationEmail = async (to, applicationData, jobDetails) => {
  const safeTitle = escapeHtml(jobDetails.title);
  const safeCompany = escapeHtml(jobDetails.company_name);
  const safeName = escapeHtml(applicationData.full_name);
  const safeEmail = escapeHtml(applicationData.email);
  const safePhone = escapeHtml(applicationData.phone);

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: to,
    subject: `Job Application Received - ${safeTitle}`,
    html: `
      <h2>Thank you for your application!</h2>
      <p>We've received your application for the position of <strong>${safeTitle}</strong> at ${safeCompany}.</p>
      
      <h3>Application Details:</h3>
      <ul>
        <li><strong>Name:</strong> ${safeName}</li>
        <li><strong>Email:</strong> ${safeEmail}</li>
        <li><strong>Phone:</strong> ${safePhone}</li>
        <li><strong>Position:</strong> ${safeTitle}</li>
        <li><strong>Company:</strong> ${safeCompany}</li>
      </ul>
      
      <p>We'll review your application and get back to you soon.</p>
      <p>Best regards,<br>${safeCompany} HR Team</p>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('Application email sent');
  } catch (error) {
    console.error('Error sending email:', error);
  }
};

module.exports = { sendApplicationEmail };