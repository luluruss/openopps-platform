var _ = require('underscore');
var Backbone = require('backbone');
var $ = require('jquery');
var TaskModel = require( '../../../entities/tasks/task_model' );

// templates
var AdminTaskTemplate = require('../templates/admin_task_template.html');
var AdminTaskView = Backbone.View.extend({
  events: {
    'click .delete-task'  : 'deleteTask',
    'click .js-task-open' : 'openTask',
  },

  initialize: function (options) {
    this.options = options;
    this.data = {
      page: 1,
    };
  },

  render: function () {
    var view = this;
    var url = '/admin/tasks';
    if (this.options.agencyId) url = url + '/' + this.options.agencyId;
    Backbone.history.navigate(url);

    $.ajax({
      url: '/api' + url,
      data: this.data,
      dataType: 'json',
      success: function (data) {
        var template = _.template(AdminTaskTemplate)(data);
        view.$el.html(template);
        view.$el.show();
        $('.tip').tooltip();
        $('.js-tip').tooltip();
      },
    });
    return this;
  },

  /*
   * Open a "submitted" task from the admin task view.
   * @param { jQuery Event } event
   */
  openTask: function (event) {
    event.preventDefault();
    var view = this;
    var id = $(event.currentTarget).data('task-id');
    var title = $( event.currentTarget ).data('task-title');
    var task = new TaskModel({ id: id });
    task.fetch( {
      success: function ( model, response, options ) {
        if (window.confirm('Are you sure you want to publish "' + model.attributes.title + '"?')) {
          $.ajax({
            url: '/api/publishTask/' + id,
            data: {'id': id, 'state': 'open'},
            type: 'POST',
          }).done(function (model, response, options) {
            view.render();
          });
        }
      },
      error: function (model, response, options) {},
    });
  },

  deleteTask: function (e) {
    var view = this,
        id = $(e.currentTarget).data('task-id'),
        title = $(e.currentTarget).data('task-title');
    e.preventDefault();
    if (window.confirm('Are you sure you want to delete "' + title + '"?')) {
      $.ajax({
        url: '/api/task/remove',
        type: 'POST',
        data: {
          id: id,
        },
      }).done(function () {
        view.render();
      });
    }
  },

  cleanup: function () {
    removeView(this);
  },
});

module.exports = AdminTaskView;
