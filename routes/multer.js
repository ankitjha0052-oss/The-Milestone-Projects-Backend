var multer = require("multer");

var serverpath = multer.diskStorage({
    destination: (req, file, path) => {
        path(null, "public/images");
    },
    filename: (req, file, path) => {
        if (file) {
            path(null, file.originalname);
        } else {
            path(new Error("File object is undefined"), null);
        }
    },
});

var upload = multer({ storage: serverpath });

module.exports = upload;
