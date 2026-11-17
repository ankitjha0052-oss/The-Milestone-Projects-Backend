const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail', 
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const sendApplicationEmail = async (to, applicationData, jobDetails) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: to,
    subject: `Job Application Received - ${jobDetails.title}`,
    html: `
      <h2>Thank you for your application!</h2>
      <p>We've received your application for the position of <strong>${jobDetails.title}</strong> at ${jobDetails.company_name}.</p>
      
      <h3>Application Details:</h3>
      <ul>
        <li><strong>Name:</strong> ${applicationData.full_name}</li>
        <li><strong>Email:</strong> ${applicationData.email}</li>
        <li><strong>Phone:</strong> ${applicationData.phone}</li>
        <li><strong>Position:</strong> ${jobDetails.title}</li>
        <li><strong>Company:</strong> ${jobDetails.company_name}</li>
      </ul>
      
      <p>We'll review your application and get back to you soon.</p>
      <p>Best regards,<br>${jobDetails.company_name} HR Team</p>
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