Parse.Cloud.define('uploadFile', async (req) => {
    const {file, name} = req.params;
    try {
        const newFile = await (await new Parse.File(name, { base64: file }).save()).toJSON();
        return newFile;
    } catch(err) {
        return err;
    }
})