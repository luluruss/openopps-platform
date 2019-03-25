const _ = require ('lodash');
const log = require('log')('app:application:service');
const db = require('../../db');
const dao = require('./dao')(db);
const Profile = require('../auth/profile');
const Import = require('./import');

async function findOrCreateApplication (user, data) {
  var application = (await dao.Application.find('user_id = ? and community_id = ? and cycle_id = ?', [user.id, data.community.communityId, data.task.cycleId]))[0];
  if (!application) {
    application = await dao.Application.insert({
      userId: user.id,
      communityId: data.community.communityId,
      cycleId: data.task.cycleId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    importProfileData(user, application.applicationId);
  }
  return application;
}

function lookForErrors (recordResults) {
  return _.reduce(recordResults, (error, recordResult) => {
    return error || _.reduce(recordResult, (innerError, record) => {
      return innerError || record.err;
    }, false);
  }, false);
}

function filterOutErrors (recordList) {
  return _.filter(recordList, (record) => {
    return !record.err;
  });
}

function sortApplicationTasks (tasks) {
  if(_.uniq(_.map(tasks, task => { return task.sortOrder; })).length == tasks.length) {
    return tasks;
  } else {
    return _.map(_.sortBy(tasks, 'sortOrder'), async (task, index) => {
      task.sortOrder = index + 1;
      return await dao.ApplicationTask.update(task).catch(() => { return task; });
    });
  }
}

function importProfileData (user, applicationId) {
  dao.Application.findOne('application_id = ? and user_id = ?', applicationId, user.id).then(() => {
    Profile.get({ access_token: user.access_token, id_token: user.id_token }).then(profile => {
      Promise.all([
        Import.profileEducation(user.id, applicationId, profile.Profile.Educations),
        Import.profileExperience(user.id, applicationId, profile.Profile.WorkExperiences),
        Import.profileLanguages(user.id, applicationId, profile.Profile.Languages),
        Import.profileReferences(user.id, applicationId, profile.Profile.References),
      ]).catch((err) => {
        // record data import error
      });
    }).catch((err) => {
      // record error getting USAJOBS profile
    });
  }).catch((err) => {
    // record error locating application
  });
}

async function processUnpaidApplication (user, data, callback) {
  var application = await findOrCreateApplication(user, data);
  var applicationTasks = await dao.ApplicationTask.find('application_id = ?', application.applicationId);
  if (_.find(applicationTasks, (applicationTask) => { return applicationTask.taskId == data.task.id; })) {
    callback(null, application.applicationId);
  } else if (applicationTasks.length >= 3) {
    callback({
      type:'maximum-reached',
      message: 'You\'ve already selected the maximum of three internships as part of your application to the U.S. Department of State Student Internship Program (Unpaid). If you want to apply to this internship, you must update your application to remove one of the selected internships.',
      applicationId: application.applicationId,
    });
  } else {
    var sortOrder = _.difference([1, 2, 3], applicationTasks.map((applicationTask) => { 
      return _.parseInt(applicationTask.sortOrder);
    }))[0];
    await dao.ApplicationTask.insert({
      applicationId: application.applicationId,
      userId: application.userId,
      taskId: data.task.id,
      sortOrder: sortOrder,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    callback(null, application.applicationId);
  }
}

async function updateEducation ( educationId,data) {
  return await dao.Education.findOne('education_id = ? and user_id = ?',educationId,data.userId).then(async (e) => { 
    return await dao.Education.update(data).then((education) => {
      return education;
    }).catch((err) => {
      log.error(err);
      return false;
    });
  }).catch((err) => {
    log.error(err);
    return false;
  });
}

module.exports = {};

module.exports.updateLanguage = async function (userId, data) {
  return await dao.ApplicationLanguageSkill.findOne('application_language_skill_id = ? and user_id =  ?', data.applicationLanguageSkillId, userId).then(async (l) => {
    return await dao.ApplicationLanguageSkill.update(_.extend(data, {
      updatedAt: l.updatedAt,
    })).then(async (language) => {
      return await dao.ApplicationLanguageSkill.query(dao.query.applicationLanguage, data.applicationId, { fetch: { 
        details: '',
        speakingProficiency: '', 
        readingProficiency: '', 
        writingProficiency: '' }});
    }).catch(err => {
      log.info('update: failed to update language', err);
      return false;
    });
  }).catch((err) => {
    return false;
  });
};

module.exports.deleteLanguage = async function (userId, applicationLanguageSkillId) {
  return await dao.ApplicationLanguageSkill.findOne('application_language_skill_id = ? and user_id =  ?', applicationLanguageSkillId, userId).then(async (l) => {
    return await dao.ApplicationLanguageSkill.delete('application_language_skill_id = ?', applicationLanguageSkillId).then(async (language) => {
      return language;
    }).catch(err => {
      log.info('delete: failed to delete language ', err);
      return false;
    });
  }).catch(err => {
    log.info('delete: record to delete not found ', err);
    return false;
  });
};

module.exports.saveLanguage = async function (userId, data) {
  return await dao.ApplicationLanguageSkill.findOne('application_id = ? and language_id = ?', [data.applicationId, data.languageId]).then(() => {
    return { err: 'language already exists' };
  }).catch(async () => { 
    return await dao.ApplicationLanguageSkill.insert(_.extend(data, {
      createdAt: new Date(),
      updatedAt: new Date(),
      userId: userId,
    })).then(async (e) => {
      return await dao.ApplicationLanguageSkill.query(dao.query.applicationLanguage, data.applicationId, { fetch: { 
        details: '',
        speakingProficiency: '', 
        readingProficiency: '', 
        writingProficiency: '' }});
    }).catch(err => {
      log.error('save: failed to save language ',  err);
      return false;
    });
  });
};

module.exports.saveSkill = async function (userId, applicationId, attributes) {
  return await dao.ApplicationSkill.delete('application_id = ? ', [applicationId]).then(async () => { 
    var tags = [].concat(attributes || []);
    return await processUserTags({ userId: userId, username: attributes.username }, applicationId, tags).then(async () => {
      return await db.query(dao.query.applicationSkill, applicationId, { fetch: { name: ''}});
    }).catch(err => {
      log.error('save: failed to save skill ',  err);
      return false;
    });
  }).catch(err => {
    log.info('delete: failed to delete skill(s) ', err);
    return false;
  });
};

function processUserTags (user, applicationId, tags) {
  return Promise.all(tags.map(async (tag) => {
    if(_.isNaN(_.parseInt(tag.id))) {
      await createNewSkillTag(user, applicationId, tag);
    } else {
      _.extend(tag, { 'createdAt': new Date(), 'updatedAt': new Date() });
      tag = _.pickBy(tag, _.identity);
      if (tag.id) {
        return await createApplicationSkill(user, applicationId, tag);
      } else {
        await createNewSkillTag(user, applicationId, tag);
      }
    }
  }));
}

async function createNewSkillTag (user, applicationId, tag) {
  tag.name = tag.name.trim();
  return await dao.TagEntity.insert({
    name: tag.name, 
    type: tag.tagType,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).then(async (t) => {
    return await createApplicationSkill(user, applicationId, t);
  }).catch(err => {
    log.info('skill: failed to create skill tag ', user.username, tag, err);
  });
}

async function createApplicationSkill (user, applicationId, tag) {
  return await dao.ApplicationSkill.insert({ 
    applicationId: applicationId, 
    userId: user.userId, 
    skillId: tag.id,
    createdAt: new Date(),
  }).catch(err => {
    log.info('skill: failed to create tag ', user.username, application_id, err);
  });
}


module.exports.apply = async function (user, taskId, callback) {
  await dao.Task.findOne('id = ?', taskId).then(async task => {
    await dao.Community.findOne('community_id = ?', task.communityId).then(async community => {
      // need a way to determine DoS Unpaid vs VSFS
      if (community.applicationProcess == 'dos') {
        await processUnpaidApplication(user, { task: task, community: community }, callback);
      } else {
        // We don't know yet how to handle this type of application
        log.error('User attempted to apply to a community task that is not defined.', taskId);
        callback({ message: 'An error occurred attempting to start your application.' });
      }
    }).catch(err => {
      log.error('User attempted to apply to task but the community was not found.', err);
      callback({ message: 'An error occurred attempting to start your application.' });
    });
  }).catch(err => {
    log.error('User attempted to apply to task but none found.', err);
    callback({ message: 'An error occurred attempting to start your application.' });
  });
};

module.exports.deleteApplicationTask = async function (userId, applicationId, taskId) {
  return new Promise((resolve, reject) => {
    dao.Application.findOne('application_id = ? and user_id = ?', applicationId, userId).then((application) => {
      db.transaction(function* (transaction) {
        yield transaction.query('DELETE from application_task WHERE task_id = $1 and application_id = $2', [taskId, applicationId]);
        var updatedAt = new Date();
        yield transaction.query('UPDATE application SET current_step = $1, updated_at = $2 WHERE application_id = $3', [1, updatedAt, applicationId]);
        return { 
          applicationId: applicationId,
          currentStep: 1,
          updatedAt: updatedAt,
        };
      }).then(async (result) => {
        resolve(result);
      }).catch((err) => {
        reject({ status: 400, message: 'An unexpected error occured attempting to remove this internship selection from your application.' });
      });
    }).catch((err) => {
      reject({ status: 403 });
    });
  });
};

module.exports.findById = async function (userId, applicationId) {
  return new Promise((resolve, reject) => {
    dao.Application.findOne('application_id = ? and user_id = ?', applicationId, userId).then(async application => {
      var results = await Promise.all([
        db.query(dao.query.applicationTasks, applicationId, { fetch: { securityClearance: '' }}),
        dao.Education.query(dao.query.applicationEducation, applicationId, { fetch: { country: '', countrySubdivision: '', degreeLevel: '', honor: '' }}),
        dao.Experience.query(dao.query.applicationExperience, applicationId, { fetch: { country: '', countrySubdivision: '' }}),
        dao.ApplicationLanguageSkill.query(dao.query.applicationLanguage, applicationId, { fetch: { 
          details: '',
          speakingProficiency: '', 
          readingProficiency: '', 
          writingProficiency: '' }}),
        dao.Reference.query(dao.query.applicationReference, applicationId, { fetch: { referenceType: '' }}),
        db.query(dao.query.applicationSkill, applicationId, { fetch: { name: ''}}),
        dao.LookUpCode.query(dao.query.securityClearance, applicationId, { fetch: { securityClearance: ''}}),
      ]);
      application.tasks = sortApplicationTasks(results[0].rows);
      application.education = results[1];
      application.experience = results[2];
      application.language = results[3];
      application.reference = results[4];
      application.skill = results[5].rows;
      application.securityClearance = results[6];
      resolve(application);
    }).catch((err) => {
      reject();
    });
  });
};

module.exports.getTranscripts = async function (user) {
  return new Promise((resolve, reject) => {
    Profile.getDocuments({ access_token: user.access_token, id_token: user.id_token }, 'transcripts').then(documents => {
      resolve(documents);
    }).catch((err) => {
      // record error getting USAJOBS profile
      reject(err);
    });
  });
};

module.exports.swapApplicationTasks = async function (userId, applicationId, data) {
  return new Promise((resolve, reject) => {
    dao.Application.findOne('application_id = ? and user_id = ?', applicationId, userId).then(async () => {
      db.transaction(function* (transaction) {
        yield transaction.query('UPDATE application_task SET sort_order = $1 WHERE application_task_id = $2', [data[1].sortOrder, data[0].applicationTaskId]);
        yield transaction.query('UPDATE application_task SET sort_order = $1 WHERE application_task_id = $2', [data[0].sortOrder, data[1].applicationTaskId]);
      }).then(async () => {
        resolve((await db.query(dao.query.applicationTasks, applicationId)).rows);
      }).catch((err) => {
        reject({ status: 400, message: 'An unexpected error occured attempting to update your internship selections from your application.' });
      });
    }).catch((err) => {
      reject({ status: 403 });
    });
  });
};

module.exports.updateApplication = async function (userId, applicationId, data) {
  return await dao.Application.findOne('application_id = ? and user_id = ?', applicationId, userId).then(async () => {
    return await dao.Application.update(data).then((application) => {
      return application;
    }).catch((err) => {
      return false;
    });
  }).catch((err) => {
    return false;
  });
};

module.exports.saveEducation = async function (attributes,done) { 
  attributes.updatedAt = new Date(); 
  attributes.createdAt= new Date();
  await dao.Education.insert(attributes).then(async (education) => {   
    return done(null, education);
  }).catch(err => {
    return done(true);
  });
};

module.exports.deleteEducation= async function (educationId){
  await dao.Education.delete('education_id = ?', educationId).then(async (education) => {
    return education;
  }).catch(err => {
    log.info('delete: failed to delete Education ', err);
    return false;
  });
};

module.exports.saveEducation = async function (attributes,done) { 
  if(attributes.educationId){ 
    await updateEducation(attributes.educationId,attributes).then((education) => {   
      return done(!education, education);
    });
  }
  else {
    attributes.createdAt= new Date();
    attributes.updatedAt = new Date();
    await dao.Education.insert(attributes).then(async (education) => {   
      return done(null, education);
    }).catch(err => {
      return done(true);
    });
  }
};

async function insertExperience (attributes) {
  return await dao.Application.findOne('application_id = ? and user_id = ?',attributes.applicationId,attributes.userId).then(async (e) => { 
    return await dao.Experience.insert(attributes).then(async (experience) => {   
      return experience;
    }).catch(err => {
      return false;
    });
  }).catch((err) => {
    log.error(err);
    return false;
  });
}

async function updateExperience (attributes) {
  return await dao.Experience.findOne('experience_id = ? and user_id = ?',attributes.experienceId,attributes.userId).then(async (e) => { 
    return await dao.Experience.update(attributes).then((experience) => {
      return experience;
    }).catch((err) => {
      log.error(err);
      return false;
    });
  }).catch((err) => {
    log.error(err);
    return false;
  });
}

module.exports.saveExperience = async function (attributes,done) { 
  attributes.countryId = attributes.country.id;
  if(attributes.countrySubdivision){
    attributes.countrySubdivisionId = attributes.countrySubdivision.id;
  }

  if (attributes.experienceId) {
    await updateExperience(attributes).then((experience) => {   
      return done(!experience, experience);
    });
  } else {
    attributes.updatedAt = new Date(); 
    attributes.createdAt = new Date();
    await insertExperience(attributes).then((experience) => {   
      return done(!experience, experience);
    });
  }
};

module.exports.deleteExperience= async function (experienceId){
  await dao.Experience.delete('experience_id = ?', experienceId).then(async (experience) => {
    return experience;
  }).catch(err => {
    log.info('delete: failed to delete Experience ', err);
    return false;
  });
};

module.exports.getEducation= async function (educationId){
  var country= (await dao.Country.db.query(dao.query.country,educationId)).rows[0];
  return await dao.Education.findOne('education_id = ?', educationId).then((education) => {  
    education.country=country;
    return education;
  }).catch((err) => {
    log.info('error', err);
    return null;
  });
};

async function insertReference (attributes) {
  return await dao.Application.findOne('application_id = ? and user_id = ?',attributes.applicationId,attributes.userId).then(async (e) => { 
    return await dao.Reference.insert(attributes).then(async (reference) => {   
      return reference;
    }).catch(err => {
      return false;
    });
  }).catch((err) => {
    log.error(err);
    return false;
  });
}

async function updateReference (attributes) {
  return await dao.Reference.findOne('reference_id = ? and user_id = ?',attributes.referenceId,attributes.userId).then(async (e) => { 
    return await dao.Reference.update(attributes).then((reference) => {
      return reference;
    }).catch((err) => {
      log.error(err);
      return false;
    });
  }).catch((err) => {
    log.error(err);
    return false;
  });
}

module.exports.saveReference = async function (attributes,done) { 
  if (attributes.referenceId) {
    await updateReference(attributes).then((reference) => {   
      return done(!reference, reference);
    });
  } else {
    attributes.updatedAt = new Date(); 
    attributes.createdAt = new Date();
    await insertReference(attributes).then((reference) => {   
      return done(!reference, reference);
    });
  }
};

module.exports.deleteReference= async function (referenceId, userId){
  return await dao.Reference.findOne('reference_id = ? and user_id = ?',referenceId,userId).then(async (e) => { 
    return await dao.Reference.delete('reference_id = ?', referenceId).then(async (reference) => {
      return reference;
    }).catch(err => {
      log.info('delete: failed to delete Reference ', err);
      return false;
    });
  }).catch((err) => {
    log.error(err);
    return false;
  });
};